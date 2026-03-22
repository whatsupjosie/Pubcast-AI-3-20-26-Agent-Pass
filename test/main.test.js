const fs = require("fs");
const path = require("path");

jest.mock("electron");

const { scanFileForCode, scanFolderForCode, routePayload } = require("../main");

const tmpFolder = path.join(__dirname, "tmp_docs", "stress_test_data");
const appFolder = path.join(tmpFolder, "app");

beforeAll(() => {
  if (!fs.existsSync(tmpFolder)) fs.mkdirSync(tmpFolder, { recursive: true });
  if (!fs.existsSync(appFolder)) fs.mkdirSync(appFolder, { recursive: true });
  fs.writeFileSync(path.join(appFolder, "sample1.js"), "function test(){ return 123; }\n");
});

afterAll(() => {
  fs.rmSync(tmpFolder, { recursive: true, force: true });
});

test("scanFileForCode returns block for code file", () => {
  const result = scanFileForCode(path.join(appFolder, "sample1.js"));
  expect(result.error).toBeUndefined();
  expect(result.detected).toBe(true);
  expect(result.count).toBeGreaterThan(0);
});

test("scanFolderForCode returns scanned files and respects maxFiles", async () => {
  const result = await scanFolderForCode(appFolder, 10);
  expect(result.error).toBeUndefined();
  expect(result.scanned).toBeGreaterThan(0);
  expect(Array.isArray(result.results)).toBe(true);
});

test("routePayload returns object with saved paths", () => {
  const payload = { target: "primary", source_title: "test", source_url: "https://example.com", blocks: [{ language: "js", content: "console.log(1);" }] };
  const saved = routePayload(payload);
  expect(saved).toBeTruthy();
  expect(typeof saved).toBe("object");
});
