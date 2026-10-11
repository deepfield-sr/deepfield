"use strict";
/*
 * Runs Java compiled to WebAssembly (WebGame) off the page's thread, in one of two roles:
 *
 * - the game: holds the match, carries out the player's clicks, and plays Deepfield's turns a
 *   move at a time, sending the page what to show after each;
 * - a searcher: one of several the page starts, each searching Deepfield's decision with its own
 *   deals, the game playing again from its seed and moves, so a decision uses several cores. The
 *   game asks them through message channels the page sets up, adds up their visits, and makes the
 *   move tried most. (The page starts them, not the game: workers started by a worker failed in
 *   testing, and some browsers don't allow them.)
 */
importScripts("deepfield.wasm-runtime.js");

const CARD_FILES = ["unaligned", "trade-federation", "blob", "star-empire", "machine-cult"];
/** The least time between Deepfield's moves, so the player can follow them. */
const PAUSE = 700;
/** Below this, a searcher's share of a decision isn't worth its overhead. */
const LEAST_PER_SEARCHER = 1500;
/** A searcher that hasn't answered by then is dropped, and the decision goes on without it. */
const SEARCHER_TIME_LIMIT = 30000;

let java = null;
let role = null;
// The level: a search of so many simulations a move, or with a temperature, moves drawn by the
// network's chances with no search.
let simulations = 24000;
let temperature = 0;
let port = null;
/** Whether this runs the JavaScript build, not the WebAssembly one. */
let slower = false;
const searchers = [];
let busy = false;
const queue = [];

self.addEventListener("error", event => fail("Uncaught: " + event.message));
self.addEventListener("unhandledrejection", event => fail("Unhandled: " + event.reason));

onmessage = event => {
  const message = event.data;
  if (message.role) {
    role = message.role;
    port = message.port || null;
    if (message.level) setLevel(message.level);
    start(message.javaScript).catch(error => fail(error));
  } else if (message.searcher) {
    addSearcher(message.searcher);
  } else {
    queue.push(message);
    drain();
  }
};

/**
 * @return the Java exports: from the WebAssembly build, or where the browser can't run it (no
 * WebAssembly GC, or not its exception handling), or when asked to, from the same code compiled
 * to JavaScript, about five times slower
 */
async function loadJava(javaScript) {
  if (!javaScript) {
    try {
      return (await TeaVM.wasmGC.load("deepfield.wasm")).exports;
    } catch (error) {
      postMessage({ log: "No WebAssembly GC here, so the slower JavaScript build: " + error });
    }
  }
  // Its module wrapper fills an object named exports when there is one, and the worker's own
  // globals otherwise.
  self.exports = {};
  importScripts("deepfield-js.js");
  const java = self.exports;
  delete self.exports;
  slower = true;
  return java;
}

async function start(javaScript) {
  const loaded = await loadJava(javaScript);
  const cards = await Promise.all(CARD_FILES.map(file => fetch("cards/" + file + ".json").then(r => r.text())));
  const names = await fetch("network-names.json").then(r => r.text());
  const numbers = new Float64Array(await fetch("network.bin").then(r => r.arrayBuffer()));
  for (const text of cards) loaded.addCards(text);
  loaded.setNetworkParts(names, numbers);
  loaded.start(Math.floor(Math.random() * 2 ** 52), simulations);
  if (temperature) loaded.setTemperature(temperature);
  // Only now: messages that came while loading wait in the queue until here.
  java = loaded;
  if (role === "search") {
    port.onmessage = event => {
      queue.push(event.data);
      drain();
    };
    port.postMessage({ ready: true });
  } else {
    postMessage({
      state: java.state(),
      status: slower ? "Ready (in the slower JavaScript build): start a game." : "Ready: start a game.",
      ready: true,
    });
  }
  drain();
}

function fail(error) {
  const text = String(error && error.stack || error);
  if (port) {
    port.postMessage({ error: text });
  } else {
    postMessage({ error: text });
  }
}

/** A searcher, reached through its end of a message channel. */
function addSearcher(channel) {
  const searcher = { channel, ready: false, pending: null };
  channel.onmessage = event => {
    if (event.data.ready) {
      searcher.ready = true;
    } else if (event.data.error) {
      searcher.ready = false;
      postMessage({ log: "A searcher failed: " + event.data.error });
      answer(searcher, null);
    } else {
      // A late answer, after the time limit, still shows it's working.
      searcher.ready = true;
      answer(searcher, event.data.visits);
    }
  };
  searchers.push(searcher);
}

function answer(searcher, visits) {
  if (searcher.pending) {
    const resolve = searcher.pending;
    searcher.pending = null;
    resolve(visits);
  }
}

/** Carries out the messages in order, one at a time, as Deepfield's turn takes a while. */
async function drain() {
  if (busy || !java) return;
  busy = true;
  try {
    while (queue.length) {
      const message = queue.shift();
      if (role === "search") {
        port.postMessage({ visits: Array.from(java.searchAt(message.seed, message.moves, message.simulations)) });
      } else if (message.level) {
        setLevel(message.level);
        if (temperature) {
          java.setTemperature(temperature);
        } else {
          java.setSimulations(simulations);
        }
      } else if (message.command !== undefined) {
        postMessage({ state: java.command(message.command) });
        await deepfieldsTurn();
      }
    }
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
  }
}

/** Plays Deepfield's moves until it's the player's move or the game is over. */
async function deepfieldsTurn() {
  let thinking = 0;
  while (java.aiToMove()) {
    const started = Date.now();
    postMessage({ status: "Deepfield is thinking..." });
    const choices = java.aiChoices();
    const state = choices === 1 ? java.aiPlay(0)
        : temperature ? java.aiMove()
        : java.aiPlay(await choose(choices));
    thinking += Date.now() - started;
    await wait(PAUSE - (Date.now() - started));
    postMessage({
      state,
      status: java.aiToMove() ? "Deepfield is thinking..."
          : "Your move. Deepfield thought for " + (thinking / 1000).toFixed(1) + " s on its turn.",
    });
  }
}

/**
 * @return the move to make: the one tried most, the simulations shared among the searchers ready,
 * or all searched here when none is
 */
async function choose(choices) {
  const ready = searchers.filter(s => s.ready);
  const used = ready.slice(0, Math.max(1, Math.min(ready.length, Math.floor(simulations / LEAST_PER_SEARCHER))));
  const seed = java.gameSeed();
  const moves = java.gameMoves();
  let results = [];
  if (used.length) {
    const share = Math.ceil(simulations / used.length);
    results = await Promise.all(used.map(searcher => new Promise(resolve => {
      searcher.pending = resolve;
      searcher.channel.postMessage({ seed, moves, simulations: share });
      setTimeout(() => {
        if (searcher.pending === resolve) {
          searcher.ready = false;
          postMessage({ log: "A searcher took too long: seed " + seed + ", moves " + moves });
          answer(searcher, null);
        }
      }, SEARCHER_TIME_LIMIT);
    })));
    results = results.filter(visits => visits && visits.length === choices);
  }
  if (!results.length) {
    results = [Array.from(java.searchAt(seed, moves, simulations))];
  }
  const totals = new Array(choices).fill(0);
  for (const visits of results) visits.forEach((v, i) => { totals[i] += v; });
  let best = 0;
  totals.forEach((v, i) => { if (v > totals[best]) best = i; });
  return best;
}

function setLevel(level) {
  simulations = level.simulations || simulations;
  temperature = level.temperature || 0;
}

function wait(millis) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, millis)));
}
