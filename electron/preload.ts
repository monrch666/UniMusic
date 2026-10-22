import { contextBridge, ipcRenderer } from "electron";
import type { MusicApi } from "../src/shared";

const api: MusicApi = {
  unified: action => ipcRenderer.invoke("music:unified", action),
  waveFeedback: (track, type, seconds) => ipcRenderer.invoke("music:waveFeedback", track, type, seconds),
  yandexSession: () => ipcRenderer.invoke("music:yandexSession"),
  yandexAuth: action => ipcRenderer.invoke("music:yandexAuth", action),
  session: () => ipcRenderer.invoke("music:session"),
  auth: (action) => ipcRenderer.invoke("music:auth", action),
  logout: () => ipcRenderer.invoke("music:logout"),
  tracks: (options) => ipcRenderer.invoke("music:tracks", options),
  search: (query, offset) => ipcRenderer.invoke("music:search", query, offset),
  playlists: (offset, source) => ipcRenderer.invoke("music:playlists", offset, source),
  resolveTrack: (track, legacy) => ipcRenderer.invoke("music:resolve", track, legacy),
  prepareTrack: track => ipcRenderer.invoke("music:prepare", track),
  reportPlaybackError: (error) => ipcRenderer.invoke("music:playbackError", error),
  browse: value => ipcRenderer.invoke("music:browse", value),
  library: value => ipcRenderer.invoke("music:library", value),
  lyrics: value => ipcRenderer.invoke("music:lyrics", value),
  offline: value => ipcRenderer.invoke("music:offline", value),
  preferences: value => ipcRenderer.invoke("music:preferences", value),
  playback: value => ipcRenderer.invoke("music:playback", value),
  trackInfo: value => ipcRenderer.invoke("music:trackInfo", value),
  copyTrack: (value, kind) => ipcRenderer.invoke("music:copyTrack", value, kind),
  copyText: value => ipcRenderer.invoke("music:copyText", value),
  played: value => ipcRenderer.invoke("music:played", value),
  diagnostics: () => ipcRenderer.invoke("music:diagnostics"),
  onCommand: callback => {
    const listener = (_event: Electron.IpcRendererEvent, command: "toggle" | "next" | "previous") => callback(command);
    ipcRenderer.on("music:command", listener);
    return () => ipcRenderer.removeListener("music:command", listener);
  },
  window: (action) => ipcRenderer.send("music:window", action),
};
contextBridge.exposeInMainWorld("unimusic", api);
