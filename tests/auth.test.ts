import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectAuth, trustedVkUrl } from "../electron/auth";
import { withCaptcha } from "../electron/captcha";
import {
  VK_APP_ID,
  type Credential,
  type Json,
  type Params,
  type Transport,
} from "../electron/vk";

function setup(responses: Json[]) {
  const calls: { method: string; params: Params; oauth: boolean }[] = [];
  const saved: Credential[] = [];
  const transport: Transport = async (method, params, oauth = false) => {
    calls.push({ method, params, oauth });
    assert.ok(responses.length, `Unexpected request: ${method}`);
    return responses.shift()!;
  };
  const auth = new DirectAuth(
    withCaptcha(transport, async () => "solved-captcha-token"),
    "0123456789abcdef",
    async (credential) => {
      saved.push(credential);
    },
  );
  return { auth, calls, saved };
}
const anonymous = { token: "anonymous-token" };
const success = {
  access_token: "vk1.a.test-token-for-unit-tests",
  user_id: 123,
  expires_in: 0,
};
const account = (method = "sms", extra: Json = {}) => ({
  response: {
    sid: "first-sid",
    flow_name: "auth_without_password",
    next_step: { verification_method: method, ...extra },
  },
});

test("VK Android direct password login: no redirect and no token in public result", async () => {
  const { auth, calls, saved } = setup([
    anonymous,
    account("password"),
    success,
  ]);
  assert.equal(
    (await auth.act({ type: "begin", login: "someone@example.com" })).step,
    "password",
  );
  const result = await auth.act({
    type: "password",
    password: " keep spaces ",
  });
  assert.equal(result.step, "complete");
  assert.equal(saved.length, 1);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["get_anonym_token", "auth.validateAccount", "token"],
  );
  assert.equal(calls[0].params.client_id, VK_APP_ID);
  assert.equal(calls[2].params.api_id, 2274003);
  assert.equal(calls[2].params.grant_type, "password");
  assert.equal(calls[2].params.password, " keep spaces ");
  assert.equal(calls[2].params.anonymous_token, "anonymous-token");
  assert.equal(calls[2].oauth, true);
  assert.equal(JSON.stringify(result).includes(success.access_token), false);
});

test("code login checks ecosystem OTP then requests without_password token", async () => {
  const { auth, calls } = setup([
    anonymous,
    account(),
    { response: { sid: "checked-sid", can_skip_password: true } },
    success,
  ]);
  assert.equal(
    (await auth.act({ type: "begin", login: "+79000000000" })).step,
    "code",
  );
  assert.equal(
    (await auth.act({ type: "code", code: "123456" })).step,
    "complete",
  );
  assert.equal(calls[2].method, "ecosystem.checkOtp");
  assert.equal(calls[2].params.verification_method, "sms");
  assert.equal(calls[3].params.grant_type, "without_password");
  assert.equal(calls[3].params.sid, "checked-sid");
});

test("VK can require password after OTP; confirmed sid is preserved", async () => {
  const response = account();
  response.response.flow_name = "need_password_and_validation";
  const { auth, calls } = setup([
    anonymous,
    response,
    { response: { sid: "verified", can_skip_password: false } },
    success,
  ]);
  await auth.act({ type: "begin", login: "test@example.com" });
  assert.equal(
    (await auth.act({ type: "code", code: "12345" })).step,
    "password",
  );
  assert.equal(
    (await auth.act({ type: "password", password: "private" })).step,
    "complete",
  );
  assert.equal(calls[3].params.grant_type, "phone_confirmation_sid");
  assert.equal(calls[3].params.sid, "verified");
});

test("available methods are restricted to supported ones and resend updates SID", async () => {
  const { auth, calls } = setup([
    anonymous,
    account("push", { has_another_verification_methods: true }),
    {
      response: {
        methods: [
          { name: "sms", priority: 1 },
          { name: "injected_method", priority: 0 },
          { name: "password", priority: 2 },
        ],
      },
    },
    { response: { sid: "sms-sid", code_length: 6, info: "+7 *** 12" } },
  ]);
  const state = await auth.act({ type: "begin", login: "test@example.com" });
  assert.deepEqual(state.methods, ["push", "sms", "password"]);
  await assert.rejects(
    auth.act({ type: "method", method: "injected_method" as "sms" }),
    /недоступен/,
  );
  const code = await auth.act({ type: "method", method: "sms" });
  assert.equal(code.step, "code");
  assert.equal(code.codeLength, 6);
  assert.equal(calls.at(-1)?.method, "ecosystem.sendOtpSms");
});

test("native password 2FA retries token with code and validation SID", async () => {
  const { auth, calls } = setup([
    anonymous,
    account("password"),
    {
      error: "need_validation",
      validation_type: "2fa_app",
      validation_sid: "2fa-sid",
    },
    success,
  ]);
  await auth.act({ type: "begin", login: "test@example.com" });
  assert.equal(
    (await auth.act({ type: "password", password: "private" })).step,
    "code",
  );
  assert.equal(
    (await auth.act({ type: "code", code: "654321" })).step,
    "complete",
  );
  assert.equal(calls[3].params.code, "654321");
  assert.equal(calls[3].params.sid, "2fa-sid");
});

test("interactive captcha result retries token without exposing challenge token", async () => {
  const { auth, calls } = setup([
    anonymous,
    account("password"),
    {
      error: "need_captcha",
      redirect_uri: "https://id.vk.com/captcha?sid=example",
    },
    success,
  ]);
  await auth.act({ type: "begin", login: "test@example.com" });
  const state = await auth.act({ type: "password", password: "private" });
  assert.equal(state.step, "complete");
  assert.equal(calls[3].params.success_token, "solved-captcha-token");
  assert.equal(JSON.stringify(state).includes("solved-captcha-token"), false);
});

test("captcha 14 after phone retries validateAccount without restarting login", async () => {
  const { auth, calls } = setup([
    anonymous,
    {
      error: {
        error_code: 14,
        redirect_uri: "https://api.vk.com/captcha?sid=fixture",
      },
    },
    account(),
    { response: { sid: "verified", can_skip_password: true } },
    success,
  ]);
  const state = await auth.act({ type: "begin", login: "+79000000000" });
  assert.equal(state.step, "code");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["get_anonym_token", "auth.validateAccount", "auth.validateAccount"],
  );
  assert.equal(calls[2].params.login, "+79000000000");
  assert.equal(calls[2].params.access_token, "anonymous-token");
  assert.equal(calls[2].params.success_token, "solved-captcha-token");
  assert.equal(
    (await auth.act({ type: "code", code: "123456" })).step,
    "complete",
  );
});

test("captcha during OTP verification preserves method and SID", async () => {
  const { auth, calls } = setup([
    anonymous,
    account(),
    {
      error: {
        error_code: 14,
        redirect_uri: "https://api.vk.com/captcha?sid=fixture",
      },
    },
    { response: { sid: "verified", can_skip_password: true } },
    success,
  ]);
  await auth.act({ type: "begin", login: "test@example.com" });
  assert.equal(
    (await auth.act({ type: "code", code: "123456" })).step,
    "complete",
  );
  assert.equal(calls[3].params.code, "123456");
  assert.equal(calls[3].params.verification_method, "sms");
  assert.equal(calls[3].params.sid, "first-sid");
});

test("cancellation drops native auth state and cannot submit old password", async () => {
  const { auth } = setup([anonymous, account("password")]);
  await auth.act({ type: "begin", login: "test@example.com" });
  await auth.act({ type: "cancel" });
  await assert.rejects(
    auth.act({ type: "password", password: "private" }),
    /шаг|истекло/,
  );
});

test("bad credentials return a safe error and are never saved", async () => {
  const { auth, saved } = setup([
    anonymous,
    account("password"),
    {
      error: "invalid_client",
      error_description: "private server text containing credentials",
    },
  ]);
  await auth.act({ type: "begin", login: "test@example.com" });
  await assert.rejects(
    auth.act({ type: "password", password: "private" }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Проверьте/);
      assert.equal(error.message.includes("private"), false);
      return true;
    },
  );
  assert.equal(saved.length, 0);
});

test("captcha URL validation rejects lookalike domains, credentials and protocols", () => {
  assert.ok(trustedVkUrl("https://id.vk.com/captcha"));
  assert.ok(trustedVkUrl("https://captcha.vk.ru/challenge"));
  for (const value of [
    "https://vk.com.attacker.test/",
    "http://vk.com/",
    "https://evil@vk.com/",
    "javascript:alert(1)",
    "https://vk.com:8443/",
  ])
    assert.equal(trustedVkUrl(value), null);
});
