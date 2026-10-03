import assert from "node:assert/strict";
import test from "node:test";
import { checkMediaAvailability, isMediaUnavailable, isResourceUnavailable, registerMediaResource, clearMediaFailure } from "./media-availability.js";

function mockFetch(context, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  context.after(() => { globalThis.fetch = original; });
}
const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nclip.ts\n#EXT-X-ENDLIST";

test("HTML player pages and failed manifests are excluded while a working alternate keeps the film visible", async context => {
  const bad = "https://media.example.com/html.m3u8";
  const other = "https://media.example.com/other.m3u8";
  registerMediaResource("film", [bad, other]);
  mockFetch(context, async url => url === bad ? new Response("<html>Access denied</html>") : new Response("Not found", { status: 404 }));
  await assert.rejects(checkMediaAvailability(bad), /已失效/);
  assert.equal(isMediaUnavailable(bad), true);
  assert.equal(isResourceUnavailable("film"), false);
  await assert.rejects(checkMediaAvailability(other), /已失效/);
  assert.equal(isResourceUnavailable("film"), true);
});

test("master playlists accept a working relative variant and cache the successful probe", async context => {
  const seen = [];
  mockFetch(context, async (url, options) => {
    seen.push(url);
    if (url.endsWith("master.m3u8")) return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nbad.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200\ngood.m3u8");
    if (url.endsWith("bad.m3u8")) return new Response("Gone", { status: 410 });
    if (url.endsWith("good.m3u8")) return new Response(playlist);
    assert.equal(options.headers, undefined);
    return new Response("fragment", { status: 206 });
  });
  const url = "https://media.example.com/master.m3u8";
  await checkMediaAvailability(url);
  await checkMediaAvailability(url);
  assert.deepEqual(seen, [url, "https://media.example.com/bad.m3u8", "https://media.example.com/good.m3u8", "https://media.example.com/clip.ts"]);
});

test("missing fragments, encryption keys and initialization maps are excluded", async context => {
  mockFetch(context, async address => {
      const broken = new URL(address).pathname.split("/")[1];
      if (address.endsWith("/stream.m3u8")) return new Response(playlist.replace("#EXT-X-TARGETDURATION:6", '#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"'));
      return new Response("body", { status: address.endsWith(broken) ? 404 : 200 });
  });
  for (const broken of ["clip.ts", "key.bin", "init.mp4"]) {
    const url = `https://media.example.com/${broken}/stream.m3u8`;
    await assert.rejects(checkMediaAvailability(url), /已失效/);
    assert.equal(isMediaUnavailable(url), true);
  }
});

test("concurrent checks share one probe and ordinary videos are not probed", async context => {
  let requests = 0;
  mockFetch(context, async url => { requests++; return new Response(url.endsWith(".m3u8") ? playlist : "fragment"); });
  const url = "https://media.example.com/concurrent.m3u8";
  await Promise.all([checkMediaAvailability(url), checkMediaAvailability(url)]);
  assert.equal(requests, 2);
  await checkMediaAvailability("https://media.example.com/movie.mp4");
  assert.equal(requests, 2);
});


test("timeouts, access restrictions and CORS probe failures do not blacklist media", async context => {
  let response;
  mockFetch(context, async () => { if (response instanceof Error) throw response; return response; });
  for (const cause of [403, 500, new TypeError("Failed to fetch"), new DOMException("Timed out", "TimeoutError")]) {
    response = typeof cause === "number" ? new Response("Denied", { status: cause }) : cause;
    const url = `https://media.example.com/uncertain-${typeof cause === "number" ? cause : cause.name}.m3u8`;
    await checkMediaAvailability(url);
    assert.equal(isMediaUnavailable(url), false);
  }
});

test("manual retry clears a confirmed failure and probes using ordinary GET requests", async context => {
  const url = "https://media.example.com/retry.m3u8";
  let working = false;
  mockFetch(context, async (address, options) => {
    assert.equal(options.headers, undefined);
    return working ? new Response(address.endsWith(".m3u8") ? playlist : "fragment") : new Response("Gone", { status: 404 });
  });
  await assert.rejects(checkMediaAvailability(url));
  assert.equal(isMediaUnavailable(url), true);
  clearMediaFailure(url);
  working = true;
  await checkMediaAvailability(url);
  assert.equal(isMediaUnavailable(url), false);
});

test("later key rotation is not incorrectly treated as a dependency of the first fragment", async context => {
  const seen = [];
  mockFetch(context, async address => {
    seen.push(address);
    if (address.endsWith(".m3u8")) return new Response(playlist.replace("#EXT-X-ENDLIST", '#EXT-X-KEY:METHOD=AES-128,URI="future-key.bin"\n#EXTINF:6,\nsecond.ts\n#EXT-X-ENDLIST'));
    return new Response("fragment");
  });
  await checkMediaAvailability("https://media.example.com/rotation.m3u8");
  assert.equal(seen.some(url => url.endsWith("future-key.bin")), false);
});
