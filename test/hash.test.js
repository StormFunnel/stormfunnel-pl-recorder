import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, itemHash, feedHash, sha256 } from "../src/lib/hash.js";

test("canonicalJson sorts keys recursively and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(canonicalJson([2, 1]), "[2,1]");
});

test("itemHash is key-order independent", () => {
  const a = { id: "X", teryt: ["1", "2"], stopien: "2" };
  const b = { stopien: "2", id: "X", teryt: ["1", "2"] };
  assert.equal(itemHash(a), itemHash(b));
});

test("itemHash changes when content changes", () => {
  assert.notEqual(itemHash({ id: "X", stopien: "2" }), itemHash({ id: "X", stopien: "3" }));
});

test("feedHash is item-order independent, content sensitive", () => {
  const i1 = { id: "A", hash: sha256("a") };
  const i2 = { id: "B", hash: sha256("b") };
  assert.equal(feedHash([i1, i2]), feedHash([i2, i1]));
  assert.notEqual(feedHash([i1, i2]), feedHash([i1, { id: "B", hash: sha256("b2") }]));
  assert.notEqual(feedHash([i1]), feedHash([i1, i2]));
});
