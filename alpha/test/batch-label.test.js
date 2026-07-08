import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function makeElement(id) {
  return {
    id,
    textContent: "",
    innerHTML: "",
    style: {},
    href: "",
    target: "",
    rel: "",
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  };
}

test("batch label page fills batch data and renders local QR svg", () => {
  const html = readFileSync(new URL("../public/batch-label.html", import.meta.url), "utf8");
  const qrLite = readFileSync(new URL("../public/qr-lite.js", import.meta.url), "utf8");
  const inlineScript = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/)?.[1];
  assert.ok(inlineScript, "batch label inline script should exist");

  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const context = {
    URLSearchParams,
    TextEncoder,
    encodeURIComponent,
    window: {
      location: {
        origin: "https://insole-mes-alpha.onrender.com",
        search: "?batch=MAT%7CRM-PU-002%7CPU-202607-08%7CA-01",
      },
    },
    navigator: {
      clipboard: {
        writeText: async () => {},
      },
    },
    document: {
      getElementById: getElement,
      createElement: () => ({ async: false, src: "", onload: null, onerror: null }),
      head: {
        appendChild(script) {
          vm.runInContext(qrLite, context);
          script.onload?.();
        },
      },
    },
  };
  context.location = context.window.location;
  vm.createContext(context);

  vm.runInContext(inlineScript, context);

  assert.equal(getElement("batch-code").textContent, "MAT|RM-PU-002|PU-202607-08|A-01");
  assert.equal(
    getElement("batch-link").textContent,
    "https://insole-mes-alpha.onrender.com/mobile.html?batch=MAT%7CRM-PU-002%7CPU-202607-08%7CA-01"
  );
  assert.equal(getElement("local-note").style.display, "none");
  assert.match(getElement("qr-image").innerHTML, /<svg[\s\S]*<\/svg>/);
  assert.equal(getElement("qr-fallback").style.display || "", "");
});
