import { test } from "node:test";
import assert from "node:assert/strict";
import { withCaptcha, type CaptchaChallenge } from "../electron/captcha";
import { VkClient, VkError, type Json, type Params } from "../electron/vk";

test("classic image captcha replays the same request with captcha_sid and captcha_key", async () => {
  const calls: Params[] = [];
  const challenges: CaptchaChallenge[] = [];
  const transport = withCaptcha(
    async (method, params, oauth) => {
      assert.equal(method, "auth.validateAccount");
      assert.equal(oauth, false);
      calls.push(params);
      return calls.length === 1
        ? {
            error: {
              error_code: 14,
              captcha_sid: "123",
              captcha_img: "https://api.vk.com/captcha.php?sid=123",
            },
          }
        : { response: { sid: "continued" } };
    },
    async (challenge) => {
      challenges.push(challenge);
      return "ABCD";
    },
  );
  const original = {
    login: "test@example.com",
    access_token: "anonymous-test",
  };
  assert.deepEqual(await transport("auth.validateAccount", original, false), {
    response: { sid: "continued" },
  });
  assert.equal(challenges[0].kind, "image");
  assert.deepEqual(calls[1], {
    ...original,
    captcha_sid: "123",
    captcha_key: "ABCD",
  });
  assert.equal("captcha_sid" in original, false);
});

test("structured captcha in token response preserves password and endpoint", async () => {
  let attempts = 0;
  const transport = withCaptcha(
    async (_method, params, oauth) => {
      assert.equal(oauth, true);
      assert.equal(params.password, " private ");
      return ++attempts === 1
        ? {
            error: {
              error_code: 14,
              redirect_uri: "https://id.vk.com/captcha",
            },
          }
        : { access_token: "test-token" };
    },
    async () => "solved",
  );
  assert.deepEqual(await transport("token", { password: " private " }, true), {
    access_token: "test-token",
  });
});

test("a replacement captcha discards the previous answer and SID", async () => {
  const responses: Json[] = [
    {
      error: {
        error_code: 14,
        captcha_sid: "old",
        captcha_img: "https://api.vk.com/captcha.php?sid=old",
      },
    },
    { error: { error_code: 14, redirect_uri: "https://id.vk.com/captcha" } },
    { response: 1 },
  ];
  let last: Params = {};
  const transport = withCaptcha(
    async (_method, params) => {
      last = params;
      return responses.shift()!;
    },
    async () => "answer",
  );
  await transport("audio.get", {});
  assert.deepEqual(last, { success_token: "answer" });
});

test("captcha on profile/music requests is solved without deleting the user session", async () => {
  let calls = 0;
  const transport = withCaptcha(
    async (_method, params) => {
      assert.equal(params.access_token, "vk1.a.user-credential-for-testing");
      return ++calls === 1
        ? {
            error: {
              error_code: 14,
              redirect_uri: "https://api.vk.com/captcha",
            },
          }
        : { response: [{ id: 123, first_name: "Тест", last_name: "Тест" }] };
    },
    async () => "solved",
  );
  const client = new VkClient(transport, {
    accessToken: "vk1.a.user-credential-for-testing",
    userId: 123,
    expiresAt: null,
  });
  assert.equal((await client.profile()).id, 123);
});

test("repeated captcha has a bounded retry count", async () => {
  let requests = 0;
  let solutions = 0;
  const transport = withCaptcha(
    async () => {
      requests++;
      return {
        error: { error_code: 14, redirect_uri: "https://id.vk.com/captcha" },
      };
    },
    async () => {
      solutions++;
      return "answer";
    },
  );
  await assert.rejects(transport("auth.validateAccount", {}), { code: 14 });
  assert.equal(requests, 4);
  assert.equal(solutions, 3);
});

test("captcha cancellation stops the request without a hidden retry", async () => {
  let requests = 0;
  const transport = withCaptcha(
    async () => {
      requests++;
      return {
        error: { error_code: 14, redirect_uri: "https://id.vk.com/captcha" },
      };
    },
    async () => {
      throw new VkError("Проверка закрыта");
    },
  );
  await assert.rejects(transport("auth.validateAccount", {}), /закрыта/);
  assert.equal(requests, 1);
});

test("missing/foreign captcha URL never opens a window or exposes request parameters", async () => {
  for (const details of [
    { error_code: 14 },
    { error_code: 14, redirect_uri: "https://vk.com.attacker.test/captcha" },
  ]) {
    const transport = withCaptcha(
      async () => ({ error: details }),
      async () => {
        assert.fail("Untrusted challenge opened");
      },
    );
    await assert.rejects(
      transport("token", { password: "private", anonymous_token: "private" }),
      (error) => {
        assert.ok(error instanceof VkError);
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
  }
});

test("errors other than captcha are returned unchanged", async () => {
  const response = { error: { error_code: 5 } };
  const transport = withCaptcha(
    async () => response,
    async () => {
      assert.fail("Unexpected captcha");
    },
  );
  assert.equal(await transport("audio.get", {}), response);
});
