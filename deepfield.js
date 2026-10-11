"use strict";
/*
 * The play page with nothing on a server: the game and Deepfield run in a worker (worker.js), from
 * Java compiled to WebAssembly. The page's script talks to it through window.deepfield instead of
 * over HTTP. This adds how hard Deepfield thinks, and what it's doing while the page waits.
 */
window.deepfield = (() => {
  // A level searches each move so many simulations, or, weaker, draws each move by the network's
  // chances at a temperature, with no search.
  const LEVELS = [
    // Against the rule-based bot, 400 games each, with g88: Beginner 17.5%, Easy 41%, Medium
    // 62.5%, Hard 85%. More search than Hard's barely tells: 400 simulations won 53% against 50,
    // and 3,000 48% against 400.
    { name: "Beginner", temperature: 2.0, about: "plays loosely, slips up often" },
    { name: "Easy", temperature: 1.5, about: "plays by feel, slips up now and then" },
    { name: "Medium", temperature: 1.0, about: "plays by feel" },
    { name: "Hard", simulations: 50, about: "a quick search of each move, nearly full strength" },
    { name: "Deepfield", simulations: 24000, about: "full strength, as the advisor plays" },
  ];
  // Remembered by name, so a new list of levels doesn't mix them up.
  const STORED_LEVEL = "deepfield-level-name";
  /** The most searchers, however many cores. */
  const MOST_SEARCHERS = 8;

  let listener = null;
  let latest = null;
  let level = LEVELS.length - 1;
  try {
    const stored = LEVELS.findIndex(choice => choice.name === localStorage.getItem(STORED_LEVEL));
    if (stored >= 0) level = stored;
  } catch (e) {
    // No storage: the default level.
  }

  const game = new Worker("worker.js");
  // ?js in the address runs the slower JavaScript build, as browsers without WebAssembly GC do.
  const javaScript = new URLSearchParams(location.search).has("js");
  game.postMessage({ role: "game", level: LEVELS[level], javaScript });
  game.onmessage = event => {
    const message = event.data;
    if (message.state) {
      latest = JSON.parse(message.state);
      if (listener) listener(latest);
    }
    if (message.status !== undefined) status(message.status);
    if (message.log) console.warn(message.log);
    if (message.error) failed(message.error);
    if (message.ready) startSearchers();
  };
  game.onerror = event => failed(event.message || "The game's worker stopped.");

  /**
   * Searchers on the other cores, each joined to the game by a channel of its own, started once the
   * game is ready so it isn't kept waiting while they load too. Until they're ready, the game
   * searches by itself.
   */
  function startSearchers() {
    const cores = navigator.hardwareConcurrency || 2;
    for (let i = 0; i < Math.max(1, Math.min(MOST_SEARCHERS, cores - 1)); i++) {
      const searcher = new Worker("worker.js");
      const channel = new MessageChannel();
      searcher.onerror = event => console.warn("A searcher stopped: " + (event.message || "no message"));
      searcher.postMessage({ role: "search", port: channel.port2, javaScript }, [channel.port2]);
      game.postMessage({ searcher: channel.port1 }, [channel.port1]);
    }
  }

  function status(text) {
    const node = document.getElementById("deepfield-status");
    if (node) node.textContent = text;
  }

  function failed(error) {
    console.error(error);
    const header = document.getElementById("header");
    header.textContent = "Something went wrong running Deepfield in this browser: " + error;
  }

  /** A choice of how hard Deepfield thinks, and a line for what it's doing, at the top of the panel. */
  function addControls() {
    const box = document.createElement("div");
    box.className = "box";
    const title = document.createElement("h2");
    title.textContent = "Deepfield";
    const label = document.createElement("label");
    label.textContent = "Strength";
    const select = document.createElement("select");
    LEVELS.forEach((choice, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = choice.name + " (" + choice.about + ")";
      select.append(option);
    });
    select.value = String(level);
    select.addEventListener("change", () => {
      level = Number(select.value);
      try {
        localStorage.setItem(STORED_LEVEL, LEVELS[level].name);
      } catch (e) {
        // Remembered for this page only.
      }
      game.postMessage({ level: LEVELS[level] });
    });
    select.style.display = "block";
    select.style.width = "100%";
    select.style.margin = "4px 0";
    label.append(select);
    const line = document.createElement("div");
    line.id = "deepfield-status";
    line.className = "empty";
    line.textContent = "Loading the AI...";
    const about = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "About";
    const text = document.createElement("div");
    text.className = "list";
    text.textContent = "Deepfield taught itself Star Realms (Base Set) by playing itself, AlphaZero style: "
        + "a neural network guiding a Monte Carlo tree search, starting from nothing but the rules. "
        + "It sees only what a player sees. Everything runs here in your browser. Hover over a card for its text.";
    about.append(summary, text);
    box.append(title, label, line, about);
    document.querySelector("aside").prepend(box);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addControls);
  } else {
    addControls();
  }

  return {
    send(text) {
      game.postMessage({ command: text });
    },
    listen(receive) {
      listener = receive;
      if (latest) receive(latest);
    },
  };
})();
