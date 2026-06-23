import { describe, it, expect, vi } from "vitest";
import { createStatusMessenger } from "../src/status.js";

function makeApi() {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 42 })),
    editMessageText: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
  };
}

describe("status messenger", () => {
  it("send returns ref", async () => {
    const m = createStatusMessenger(makeApi() as any);
    const ref = await m.send(1, "раз");
    expect(ref).toEqual({ chatId: 1, msgId: 42 });
  });

  it("skips edit when text unchanged", async () => {
    const api = makeApi();
    const m = createStatusMessenger(api as any);
    const ref = await m.send(1, "раз");
    await m.edit(ref, "раз");
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("edits when text changes", async () => {
    const api = makeApi();
    const m = createStatusMessenger(api as any);
    const ref = await m.send(1, "раз");
    await m.edit(ref, "два");
    expect(api.editMessageText).toHaveBeenCalledWith(1, 42, "два", undefined);
  });

  it("retries once on 429 RetryAfter", async () => {
    const api = makeApi();
    const err = { error_code: 429, parameters: { retry_after: 0.01 }, message: "rate" };
    api.editMessageText.mockRejectedValueOnce(err).mockResolvedValueOnce(true);
    const m = createStatusMessenger(api as any);
    const ref = await m.send(1, "раз");
    await m.edit(ref, "два");
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
  });

  it("swallows non-429 errors without throwing", async () => {
    const api = makeApi();
    api.editMessageText.mockRejectedValue({ error_code: 400, message: "message is not modified" });
    const m = createStatusMessenger(api as any);
    const ref = await m.send(1, "раз");
    await expect(m.edit(ref, "два")).resolves.toBeUndefined();
  });

  it("delete swallows errors", async () => {
    const api = makeApi();
    api.deleteMessage.mockRejectedValue(new Error("gone"));
    const m = createStatusMessenger(api as any);
    const ref = await m.send(1, "раз");
    await expect(m.delete(ref)).resolves.toBeUndefined();
  });
});
