import { useEffect, useRef, useState } from "react";
import { MorphIcon } from "morphicons/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  LoaderCircle,
  LockKeyhole,
  X,
} from "lucide";
import type {
  AuthAction,
  AuthMethod,
  AuthState,
  MusicApi,
  Profile,
} from "./shared";

const labels: Record<AuthMethod, string> = {
  push: "Код в приложении VK",
  sms: "SMS на телефон",
  email: "Письмо на почту",
  callreset: "Последние цифры звонящего номера",
  password: "Пароль VK",
  codegen: "Код из приложения аутентификации",
  reserve_code: "Резервный код",
};

export default function LoginDialog({
  api,
  onClose,
  onLogin,
}: {
  api: MusicApi;
  onClose: () => void;
  onLogin: (profile: Profile) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<AuthState>({ step: "login", methods: [] });
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    input.current?.focus();
  }, [state.step]);

  async function act(action: AuthAction) {
    setBusy(true);
    setError("");
    try {
      const response = await api.auth(action);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setValue("");
      if (response.data.step === "complete" && response.data.profile) {
        onLogin(response.data.profile);
        return;
      }
      setState(response.data);
    } catch {
      setError("Не удалось связаться с приложением. Повторите попытку.");
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (busy) return;
    await api.auth({ type: "cancel" });
    onClose();
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (state.step === "login") void act({ type: "begin", login: value });
    if (state.step === "password")
      void act({ type: "password", password: value });
    if (state.step === "code") void act({ type: "code", code: value });
  }

  return (
    <dialog
      ref={dialog}
      className="login-dialog"
      aria-labelledby="login-title"
      onCancel={(event) => {
        event.preventDefault();
        void close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) void close();
      }}
    >
      <button
        className="icon-button dialog-close"
        aria-label="Закрыть вход"
        disabled={busy}
        onClick={() => void close()}
      >
        <MorphIcon icon={X} size={20} reducedMotion="user" />
      </button>
      <div className="vk-badge">VK</div>
      <h2 id="login-title">
        {state.step === "login"
          ? "Войти в VK"
          : state.step === "password"
            ? "Введите пароль"
            : "Подтвердите вход"}
      </h2>
      <p className="dialog-description">
        {state.step === "login"
          ? "Подключите аккаунт, чтобы слушать свою музыку и плейлисты."
          : state.step === "methods"
            ? "Выберите удобный способ подтверждения."
            : state.step === "password"
              ? "Используйте пароль от вашего аккаунта VK."
              : state.info ||
                (state.method ? labels[state.method] : "Введите код от VK.")}
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {state.step === "methods" ? (
        <div className="auth-methods">
          {state.methods.map((method) => (
            <button
              key={method}
              disabled={busy}
              onClick={() => void act({ type: "method", method })}
            >
              {labels[method]}
              <MorphIcon icon={ArrowRight} size={18} reducedMotion="user" />
            </button>
          ))}
        </div>
      ) : (
        <form onSubmit={submit}>
          {["login", "password", "code"].includes(state.step) && (
            <label className="auth-field">
              <span>
                {state.step === "login"
                  ? "Телефон или почта"
                  : state.step === "password"
                    ? "Пароль"
                    : "Код подтверждения"}
              </span>
              <input
                ref={input}
                value={value}
                disabled={busy}
                onChange={(event) => setValue(event.target.value)}
                type={state.step === "password" ? "password" : "text"}
                inputMode={state.step === "code" ? "numeric" : undefined}
                autoComplete={
                  state.step === "login"
                    ? "username"
                    : state.step === "password"
                      ? "current-password"
                      : "one-time-code"
                }
                maxLength={state.step === "password" ? 1024 : 200}
                placeholder={
                  state.step === "login"
                    ? "+7 900 000-00-00"
                    : state.step === "password"
                      ? "Ваш пароль"
                      : state.codeLength
                        ? `${state.codeLength} цифр`
                        : "Код от VK"
                }
                required
              />
            </label>
          )}
          <button
            className="button primary auth-submit"
            disabled={busy || !value.trim()}
            type="submit"
          >
            {busy
              ? "Подождите…"
              : state.step === "password" || state.step === "code"
                ? "Войти"
                : "Продолжить"}
            <MorphIcon
              className={busy ? "spinning" : ""}
              icon={
                busy ? LoaderCircle : state.step === "code" ? Check : ArrowRight
              }
              size={19}
              reducedMotion="user"
            />
          </button>
        </form>
      )}
      {state.step !== "login" && (
        <button
          className="text-button auth-back"
          disabled={busy}
          onClick={() => void act({ type: "cancel" })}
        >
          <MorphIcon icon={ArrowLeft} size={16} reducedMotion="user" /> Другой
          аккаунт
        </button>
      )}
      {state.step === "code" &&
        state.method &&
        ["push", "email", "sms", "callreset"].includes(state.method) && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void act({ type: "method", method: state.method! })}
          >
            Запросить новый код
          </button>
        )}
      {state.step === "code" && state.methods.length > 1 && (
        <button
          className="text-button"
          disabled={busy}
          onClick={() => {
            setState({ ...state, step: "methods" });
            setValue("");
          }}
        >
          Другой способ подтверждения
        </button>
      )}
      <div className="login-privacy">
        <MorphIcon icon={LockKeyhole} size={15} reducedMotion="user" />
        <span>
          Вход через VK Android. Пароль не сохраняется.
          <br />
          Сессия защищена шифрованием Windows.
        </span>
      </div>
    </dialog>
  );
}
