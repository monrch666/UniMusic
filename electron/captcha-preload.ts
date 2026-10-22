import { contextBridge, ipcRenderer } from "electron";

// This isolated bridge only reports the result of VK's interactive captcha.
contextBridge.exposeInMainWorld("AndroidBridge", {
  VKCaptchaGetResult: (data: unknown) => {
    if (typeof data === "string" && data.length < 16_384)
      ipcRenderer.send("captcha:result", data);
  },
  VKCaptchaCloseCaptcha: () => ipcRenderer.send("captcha:close"),
  VKCaptchaListenSensorsStart: () => {},
  VKCaptchaListenSensorsStop: () => {},
});

contextBridge.exposeInMainWorld("unimusicCaptcha", {
  submit: (key: unknown) => {
    if (typeof key === "string" && key.trim() && key.length <= 256)
      ipcRenderer.send("captcha:result", JSON.stringify({ token: key.trim() }));
  },
  cancel: () => ipcRenderer.send("captcha:close"),
});
