import type { AuthAction, AuthMethod, AuthState } from "../src/shared";
import {
  object,
  string,
  number,
  unwrap,
  VkError,
  VK_APP_ID,
  validCredential,
  type Credential,
  type Params,
  type Transport,
} from "./vk";

const METHODS: AuthMethod[] = [
  "push",
  "email",
  "sms",
  "callreset",
  "password",
  "reserve_code",
  "codegen",
];
// These are the public Android client parameters used by Fenrir; they do not identify a UniMusic user.
const ANDROID_CLIENT_SECRET = "hHbZxrka2uZ6jB1inYsH";

export function trustedVkUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["vk.com", "vk.ru", "vkcaptcha.ru", "vkcaptcha.com"].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export class DirectAuth {
  private anonymousToken = "";
  private sid = "";
  private login = "";
  private flow = "";
  private password = "";
  private methods: AuthMethod[] = [];
  private method: AuthMethod = "password";
  private tokenCode = false;
  private checkedOtp = false;
  private createdAt = 0;
  private state: AuthState = { step: "login", methods: [] };
  private busy = false;

  constructor(
    private transport: Transport,
    private deviceId: string,
    private save: (credential: Credential) => Promise<void>,
  ) {}

  reset(): AuthState {
    this.anonymousToken =
      this.sid =
      this.login =
      this.flow =
      this.password =
        "";
    this.methods = [];
    this.tokenCode = this.checkedOtp = false;
    this.createdAt = 0;
    this.state = { step: "login", methods: [] };
    return this.state;
  }

  async act(input: AuthAction): Promise<AuthState> {
    if (this.busy)
      throw new VkError("Дождитесь завершения предыдущего запроса.");
    const action = object(input);
    this.busy = true;
    try {
      if (action.type === "cancel") return this.reset();
      if (action.type === "begin") return await this.begin(action.login);
      if (!this.createdAt || Date.now() - this.createdAt > 10 * 60_000) {
        this.reset();
        throw new VkError("Время входа истекло. Введите номер заново.");
      }
      if (
        action.type === "method" &&
        (this.state.step === "methods" ||
          this.state.step === "code" ||
          this.state.step === "password")
      ) {
        if (!this.methods.includes(action.method as AuthMethod))
          throw new VkError("Этот способ подтверждения недоступен.");
        return await this.choose(action.method as AuthMethod);
      }
      if (action.type === "code" && this.state.step === "code") {
        const code = string(action.code).trim();
        if (!/^[\dA-Za-z-]{3,32}$/.test(code))
          throw new VkError("Введите код подтверждения.");
        if (this.tokenCode) return await this.token(code);
        const result = object(
          unwrap(
            await this.transport(
              "ecosystem.checkOtp",
              this.params({ code, verification_method: this.method }),
            ),
          ),
        );
        this.sid = string(result.sid) || this.sid;
        this.checkedOtp = true;
        if (
          this.flow === "need_password_and_validation" &&
          !result.can_skip_password
        )
          return this.update("password");
        return await this.token();
      }
      if (action.type === "password" && this.state.step === "password") {
        if (
          typeof action.password !== "string" ||
          !action.password ||
          action.password.length > 1024
        )
          throw new VkError("Введите пароль VK.");
        this.password = action.password;
        return await this.token();
      }
      throw new VkError("Этот шаг входа уже завершён. Начните вход заново.");
    } finally {
      this.busy = false;
    }
  }

  private update(
    step: AuthState["step"],
    extra: Partial<AuthState> = {},
  ): AuthState {
    this.state = { step, methods: this.methods, method: this.method, ...extra };
    return this.state;
  }
  private params(extra: Params = {}): Params {
    return {
      api_id: VK_APP_ID,
      device_id: this.deviceId,
      sak_version: "15.0.2",
      access_token: this.anonymousToken,
      sid: this.sid,
      ...extra,
    };
  }
  private async begin(value: unknown): Promise<AuthState> {
    if (
      typeof value !== "string" ||
      value.trim().length < 3 ||
      value.length > 200
    )
      throw new VkError("Введите номер телефона или почту VK.");
    this.reset();
    this.createdAt = Date.now();
    this.login = value.trim();
    const anonymous = await this.transport(
      "get_anonym_token",
      {
        api_id: VK_APP_ID,
        client_id: VK_APP_ID,
        client_secret: ANDROID_CLIENT_SECRET,
        device_id: this.deviceId,
      },
      true,
    );
    this.anonymousToken = string(anonymous.token);
    if (!this.anonymousToken)
      throw new VkError(
        "VK не выдал анонимный токен для входа. Повторите попытку позже.",
      );
    const account = object(
      unwrap(
        await this.transport(
          "auth.validateAccount",
          this.params({
            login: this.login,
            supported_ways: METHODS.join(","),
            force_password: 0,
            passkey_supported: 0,
            flow_type: "auth_without_password",
          }),
        ),
      ),
    );
    this.sid = string(account.sid);
    this.flow = string(account.flow_name);
    if (this.flow === "need_registration")
      throw new VkError("VK не нашёл аккаунт с этим номером или почтой.");
    const next = object(account.next_step);
    const method = string(next.verification_method) || "password";
    if (!METHODS.includes(method as AuthMethod))
      throw new VkError(
        "VK запросил способ входа, который пока не поддерживается.",
      );
    this.method = method as AuthMethod;
    this.methods = [this.method];
    if (next.has_another_verification_methods) {
      const result = object(
        unwrap(
          await this.transport(
            "ecosystem.getVerificationMethods",
            this.params(),
          ),
        ),
      );
      const available = Array.isArray(result.methods)
        ? [...result.methods].sort(
            (a, b) => number(object(a).priority) - number(object(b).priority),
          )
        : [];
      this.methods = [
        ...new Set([
          this.method,
          ...available
            .map((m) => string(object(m).name))
            .filter((m) => METHODS.includes(m as AuthMethod)),
        ]),
      ] as AuthMethod[];
    }
    if (this.method === "password") return this.update("password");
    // validateAccount has already sent the first code, as in the native VK ID flow.
    return this.update(this.methods.length > 1 ? "methods" : "code", {
      info: "Подтвердите вход кодом от VK.",
    });
  }

  private async choose(method: AuthMethod): Promise<AuthState> {
    this.method = method;
    this.tokenCode = false;
    this.password = "";
    this.checkedOtp = false;
    if (method === "password") return this.update("password");
    if (method === "codegen" || method === "reserve_code")
      return this.update("code");
    const suffix = method.charAt(0).toUpperCase() + method.slice(1);
    const result = object(
      unwrap(await this.transport(`ecosystem.sendOtp${suffix}`, this.params())),
    );
    this.sid = string(result.sid) || this.sid;
    return this.update("code", {
      info: string(result.info),
      codeLength: number(result.code_length) || undefined,
    });
  }

  private async token(code?: string): Promise<AuthState> {
    const data = await this.transport(
      "token",
      {
        api_id: VK_APP_ID,
        username: this.login,
        password: this.password || undefined,
        grant_type:
          this.checkedOtp && this.password
            ? "phone_confirmation_sid"
            : this.method === "password"
              ? "password"
              : "without_password",
        sid: this.sid,
        anonymous_token: this.anonymousToken,
        device_id: this.deviceId,
        "2fa_supported": 1,
        libverify_support: 0,
        scope: "all",
        sak_version: "15.0.2",
        flow_type: "tg_flow",
        code,
      },
      true,
    );
    if (data.error === "need_validation") {
      this.sid = string(data.validation_sid) || this.sid;
      const type = string(data.validation_type);
      if (
        [
          "2fa_sms",
          "2fa_callreset",
          "2fa_app",
          "2fa_push",
          "2fa_libverify",
        ].includes(type)
      ) {
        this.tokenCode = true;
        if (type === "2fa_libverify") {
          const phone = object(
            unwrap(
              await this.transport(
                "auth.validatePhone",
                this.params({
                  phone: this.login,
                  libverify_support: 1,
                  allow_callreset: 1,
                }),
              ),
            ),
          );
          this.sid = string(phone.sid) || this.sid;
        }
        return this.update("code", {
          info: `Введите код подтверждения VK${string(data.phone_mask) ? ` для ${string(data.phone_mask)}` : ""}.`,
        });
      }
      throw new VkError(
        "VK требует дополнительного подтверждения аккаунта. Завершите его в официальном приложении VK и повторите вход.",
      );
    }
    if (data.error) {
      if (typeof data.error === "object") unwrap(data);
      const errors: Record<string, string> = {
        invalid_client: "VK отклонил вход. Проверьте номер, пароль или код.",
        invalid_grant:
          "Неверный или истёкший код подтверждения. Запросите новый.",
        invalid_request: "VK отклонил параметры входа. Начните вход заново.",
      };
      throw new VkError(
        errors[string(data.error)] ||
          "Не удалось войти в VK. Повторите попытку позже.",
      );
    }
    const expiry = number(data.expires_in);
    const credential: Credential = {
      accessToken: string(data.access_token),
      userId: number(data.user_id),
      expiresAt:
        number(data.expired_at) > 0
          ? number(data.expired_at) * 1000
          : expiry > 0
            ? Date.now() + expiry * 1000
            : null,
    };
    if (!validCredential(credential))
      throw new VkError("VK не вернул действующий токен пользователя.");
    await this.save(credential);
    this.reset();
    return { step: "complete", methods: [] };
  }
}
