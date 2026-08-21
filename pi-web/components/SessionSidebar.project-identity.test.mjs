import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const customPathStart = source.indexOf("const commitCustomPath = useCallback");
const customPathEnd = source.indexOf("const handleCustomPathClick", customPathStart);
const customPathSource = source.slice(customPathStart, customPathEnd);

test("custom cwd selection installs validated identity before creating a draft", () => {
  assert.notEqual(customPathStart, -1);
  assert.notEqual(customPathEnd, -1);
  assert.match(customPathSource, /projectRoot\?: string;[\s\S]*?projectKey\?: string;/);

  const identityUpdate = customPathSource.indexOf("setValidatedProject(");
  const draftUpdate = customPathSource.indexOf("onNewSession?.(");
  assert.ok(identityUpdate >= 0, "validated project identity is retained");
  assert.ok(draftUpdate > identityUpdate, "identity is retained before draft creation");
  assert.equal(customPathSource.includes("setSelectedCwd("), false, "folder selection does not switch the active project");
});
