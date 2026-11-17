import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorPicker } from "../extension/author-picker.js";

function fakeElement(extra = {}) {
  const listeners = {};
  return {
    value: "", hidden: true, innerHTML: "", listeners,
    addEventListener: (name, listener) => { listeners[name] = listener; },
    setAttribute() {}, select() {}, focus() {}, querySelector: () => null,
    ...extra,
  };
}

function setup() {
  const input = fakeElement();
  const list = fakeElement();
  const clearButton = fakeElement();
  let changes = 0;
  const picker = createAuthorPicker({ input, list, clearButton, onChange: () => { changes += 1; } });
  picker.setAuthors([{ author: "alice", name: "爱丽丝", count: 3 }, { author: "bob", name: "", count: 1 }]);
  const pick = (index) => {
    input.listeners.focus();
    list.listeners.mousedown({ preventDefault() {}, target: { closest: () => ({ dataset: { index: String(index) } }) } });
  };
  return { input, list, clearButton, picker, pick, changes: () => changes };
}

test("picking an author shows the nickname in the box but filters by the handle", () => {
  const { input, picker, pick, changes, clearButton } = setup();
  pick(0);
  assert.equal(input.value, "爱丽丝");
  assert.equal(picker.value(), "alice");
  assert.equal(changes(), 1);
  assert.equal(clearButton.hidden, false);
});

test("an author without a nickname shows the handle", () => {
  const { input, picker, pick } = setup();
  pick(1);
  assert.equal(input.value, "bob");
  assert.equal(picker.value(), "bob");
});

test("typing replaces the picked author with free text", () => {
  const { input, picker, pick } = setup();
  pick(0);
  input.value = "bo";
  input.listeners.input();
  assert.equal(picker.value(), "bo");
});

test("an author chosen from a card is shown by nickname, and clearing empties the filter", () => {
  const { input, picker, clearButton } = setup();
  picker.select("alice");
  assert.deepEqual([input.value, picker.value()], ["爱丽丝", "alice"]);
  picker.select("stranger");
  assert.deepEqual([input.value, picker.value()], ["stranger", "stranger"]);
  picker.select("");
  assert.deepEqual([input.value, picker.value(), clearButton.hidden], ["", "", true]);
});

test("a nickname that arrives after the author was picked updates the box", () => {
  const { input, picker } = setup();
  picker.select("bob");
  picker.setAuthors([{ author: "bob", name: "Bob the Builder", count: 2 }]);
  assert.deepEqual([input.value, picker.value()], ["Bob the Builder", "bob"]);
});

test("the picked author is marked in the list even though the box shows the nickname", () => {
  const { list, pick, input } = setup();
  pick(0);
  input.listeners.focus();
  assert.match(list.innerHTML, /aria-selected="true">.*爱丽丝/);
  assert.equal((list.innerHTML.match(/aria-selected="true"/g) || []).length, 1);
});
