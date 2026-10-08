import { test, expect } from "@playwright/test";
import { EMPTY_QUEUE, FOLDER_BATCH_SIZE, loadQueue, nextBatch, nextBatchSize, queueReducer, summarize, QUEUE_STORAGE_KEY } from "../src/lib/download-queue";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ trackId: i + 1, title: `T${i + 1}`, artist: "A", downloadUrl: `https://api.soundcloud.com/tracks/soundcloud:tracks:${i + 1}/download` }));

test("enqueue de-duplicates, start runs only with work to do", () => {
  let s = queueReducer(EMPTY_QUEUE, { type: "enqueue", sourceTitle: "Likes", items: [...items(3), items(1)[0]] });
  expect(s.items).toHaveLength(3);
  expect(s.running).toBe(false);
  s = queueReducer(s, { type: "start" });
  expect(s.running).toBe(true);
  expect(queueReducer(EMPTY_QUEUE, { type: "start" }).running).toBe(false);
});

test("batches of ten; a 429-held item is retried on the next batch; the last result stops the queue", () => {
  let s = queueReducer(queueReducer(EMPTY_QUEUE, { type: "enqueue", sourceTitle: "L", items: items(12) }), { type: "start" });
  expect(nextBatch(s).map((i) => i.trackId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  s = queueReducer(s, { type: "fetching", trackIds: [1, 2] });
  s = queueReducer(s, { type: "result", trackId: 1, status: "started" });
  s = queueReducer(s, { type: "result", trackId: 2, status: "rate_limited" });
  expect(nextBatch(s)[0].trackId).toBe(2);
  for (const id of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) s = queueReducer(s, { type: "result", trackId: id, status: "started" });
  expect(s.running).toBe(true);
  s = queueReducer(s, { type: "result", trackId: 12, status: "unavailable", reason: "off" });
  expect(s.running).toBe(false);
  expect(summarize(s)).toMatchObject({ total: 12, started: 11, unavailable: 1, waiting: 0, finished: 12 });
});

test("pause puts in-flight items back; a reload resumes as paused with a reason", () => {
  let s = queueReducer(queueReducer(EMPTY_QUEUE, { type: "enqueue", sourceTitle: "L", items: items(2) }), { type: "start" });
  s = queueReducer(s, { type: "fetching", trackIds: [1, 2] });
  const paused = queueReducer(s, { type: "pause", reason: "Paused." });
  expect(paused.items.map((i) => i.status)).toEqual(["pending", "pending"]);

  const store = new Map<string, string>([[QUEUE_STORAGE_KEY, JSON.stringify(s)]]);
  const loaded = loadQueue({ getItem: (k) => store.get(k) ?? null });
  expect(loaded.running).toBe(false);
  expect(loaded.items.map((i) => i.status)).toEqual(["pending", "pending"]);
  expect(loaded.pausedReason).toMatch(/reloaded/);
});

test("corrupt or blocked storage loads as an empty queue", () => {
  expect(loadQueue({ getItem: () => "{nope" })).toEqual(EMPTY_QUEUE);
  expect(loadQueue({ getItem: () => { throw new Error("blocked"); } })).toEqual(EMPTY_QUEUE);
  expect(loadQueue(null)).toEqual(EMPTY_QUEUE);
});

test("before the first confirmation the queue fetches only up to the second file, then waits on a check", () => {
  let s = queueReducer(queueReducer(EMPTY_QUEUE, { type: "enqueue", sourceTitle: "L", items: items(5) }), { type: "start" });
  expect(nextBatchSize(s, false)).toBe(2);
  expect(nextBatchSize(s, true)).toBe(10);
  s = queueReducer(s, { type: "fetching", trackIds: [1, 2] });
  s = queueReducer(s, { type: "result", trackId: 1, status: "started" });
  expect(nextBatchSize(s, false)).toBe(1);
  s = queueReducer(s, { type: "result", trackId: 2, status: "started" });
  s = queueReducer(s, { type: "check", trackId: 2, title: "T2" });
  expect(s.running).toBe(false);
  expect(s.check).toEqual({ trackId: 2, title: "T2" });
  // Start is refused until the check is answered.
  expect(queueReducer(s, { type: "start" }).running).toBe(false);

  const yes = queueReducer(queueReducer(s, { type: "confirmSaved" }), { type: "start" });
  expect(yes.check).toBeUndefined();
  expect(yes.running).toBe(true);
  expect(yes.items.find((i) => i.trackId === 2)!.status).toBe("started");

  const no = queueReducer(queueReducer(s, { type: "retryChecked" }), { type: "start" });
  expect(no.items.find((i) => i.trackId === 2)!.status).toBe("pending");
  expect(nextBatch(no)[0].trackId).toBe(2);
});

test("a pending check blocks a new enqueue as well as start — it must be answered, not restarted around", () => {
  let s = queueReducer(queueReducer(EMPTY_QUEUE, { type: "enqueue", sourceTitle: "L", items: items(3) }), { type: "start" });
  s = queueReducer(s, { type: "fetching", trackIds: [1, 2] });
  s = queueReducer(s, { type: "result", trackId: 1, status: "started" });
  s = queueReducer(s, { type: "result", trackId: 2, status: "started" });
  s = queueReducer(s, { type: "check", trackId: 2, title: "T2" });
  // "Download all" again used to replace the queue and forget the check, so a
  // browser that never answered it stopped at two files on every run.
  const again = queueReducer(s, { type: "enqueue", sourceTitle: "L", items: items(3) });
  expect(again).toBe(s);
  expect(again.check).toEqual({ trackId: 2, title: "T2" });
  expect(summarize(again).started).toBe(2);
  // Answered, a new source is accepted as before.
  const answered = queueReducer(s, { type: "confirmSaved" });
  expect(queueReducer(answered, { type: "enqueue", sourceTitle: "M", items: items(1) }).sourceTitle).toBe("M");
});

test("folder mode: five links per call, never a check, a save in flight goes back to waiting on pause or reload, and saved counts as finished", () => {
  let s = queueReducer(queueReducer(EMPTY_QUEUE, { type: "enqueue", sourceTitle: "L", items: items(7), mode: "folder" }), { type: "start" });
  expect(s.mode).toBe("folder");
  expect(FOLDER_BATCH_SIZE).toBe(5);
  expect(nextBatchSize(s, false)).toBe(5);
  expect(nextBatchSize(s, true)).toBe(5);
  s = queueReducer(s, { type: "fetching", trackIds: [1, 2, 3, 4, 5] });
  s = queueReducer(s, { type: "saving", trackId: 1 });
  expect(s.items[0].status).toBe("saving");
  expect(summarize(s).waiting).toBe(7);

  const paused = queueReducer(s, { type: "pause", reason: "Paused." });
  expect(paused.items.slice(0, 5).map((i) => i.status)).toEqual(["pending", "pending", "pending", "pending", "pending"]);
  const store = new Map<string, string>([[QUEUE_STORAGE_KEY, JSON.stringify(s)]]);
  const reloaded = loadQueue({ getItem: (k) => store.get(k) ?? null });
  expect(reloaded.mode).toBe("folder");
  expect(reloaded.items[0].status).toBe("pending");

  s = queueReducer(s, { type: "result", trackId: 1, status: "saved", fileName: "A - T1.wav" });
  expect(s.items[0]).toMatchObject({ status: "saved", fileName: "A - T1.wav" });
  for (const id of [2, 3, 4, 5, 6]) s = queueReducer(s, { type: "result", trackId: id, status: "saved", fileName: `A - T${id}.mp3` });
  expect(s.running).toBe(true);
  s = queueReducer(s, { type: "result", trackId: 7, status: "failed", reason: "SoundCloud's download link had expired." });
  expect(s.running).toBe(false);
  expect(summarize(s)).toMatchObject({ total: 7, saved: 6, started: 0, failed: 1, waiting: 0, finished: 7 });
  // Queues saved before the mode existed were all tab queues.
  expect(queueReducer(EMPTY_QUEUE, { type: "enqueue", sourceTitle: "L", items: items(1) }).mode).toBe("tab");
});
