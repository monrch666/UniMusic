import { trustedVkUrl } from "./auth";
import {
  number,
  object,
  string,
  VkError,
  type Params,
  type Transport,
} from "./vk";

export type CaptchaChallenge = { kind: "web" | "image"; url: string };

export function withCaptcha(
  transport: Transport,
  solve: (challenge: CaptchaChallenge) => Promise<string>,
): Transport {
  return async (method, params, oauth) => {
    let answer: Params = {};
    for (let attempt = 0; ; attempt++) {
      const response = await transport(method, { ...params, ...answer }, oauth);
      const error = object(response.error);
      if (number(error.error_code) !== 14 && response.error !== "need_captcha")
        return response;
      if (attempt === 3)
        throw new VkError(
          "VK повторно запросил капчу. Попробуйте выполнить действие ещё раз.",
          14,
        );
      const details = response.error === "need_captcha" ? response : error;
      const webUrl = trustedVkUrl(details.redirect_uri);
      const imageUrl = trustedVkUrl(details.captcha_img);
      const sid = string(details.captcha_sid);
      if (webUrl) {
        answer = { success_token: await solve({ kind: "web", url: webUrl }) };
      } else if (imageUrl && sid && sid.length <= 1024) {
        answer = {
          captcha_sid: sid,
          captcha_key: await solve({ kind: "image", url: imageUrl }),
        };
      } else {
        throw new VkError(
          "VK запросил капчу, но не передал допустимый адрес проверки.",
          14,
        );
      }
      const key = answer.success_token ?? answer.captcha_key;
      if (typeof key !== "string" || !key.trim() || key.length > 8192)
        throw new VkError(
          "Проверка VK не вернула результат. Повторите попытку.",
          14,
        );
    }
  };
}
