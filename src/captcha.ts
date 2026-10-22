import "./captcha.css";

declare global {
  interface Window {
    unimusicCaptcha: { submit(key: string): void; cancel(): void };
  }
}

const image = document.querySelector<HTMLImageElement>("#captcha-image")!;
const input = document.querySelector<HTMLInputElement>("#captcha-key")!;
const error = document.querySelector<HTMLElement>("#captcha-error")!;
image.onerror = () => {
  error.hidden = false;
};
image.src = new URLSearchParams(location.search).get("image") || "";
document.querySelector("#captcha-form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  if (input.value.trim()) window.unimusicCaptcha.submit(input.value);
});
document
  .querySelector("#captcha-cancel")!
  .addEventListener("click", () => window.unimusicCaptcha.cancel());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.unimusicCaptcha.cancel();
});
