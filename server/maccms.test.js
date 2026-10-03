import assert from "node:assert/strict";
import test from "node:test";
import { fetchMacCms } from "./maccms.js";

test("MacCMS detail keeps direct media episodes and ignores player pages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url.searchParams.get("ac"), "detail");
    assert.equal(url.searchParams.get("ids"), "42");
    return new Response(JSON.stringify({ page: 1, pagecount: 1, list: [{
      vod_id: 42, vod_name: "片名", vod_play_from: "hls$$$web",
      vod_play_url: "第一集$https://media.example.com/1.m3u8#第二集$https://media.example.com/2.mp4$$$网页$https://example.com/watch/42",
    }] }));
  };
  try {
    const result = await fetchMacCms({ url: "https://example.com/api.php/provide/vod/" }, { id: "42" });
    assert.equal(result.list[0].episodes.length, 2);
    assert.equal(result.list[0].episodes[0].label, "第一集");
  } finally { globalThis.fetch = originalFetch; }
});
