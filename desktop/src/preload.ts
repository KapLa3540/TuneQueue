import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, Action, ActionResult } from './shared/types.js';
import { IPC } from './shared/types.js';

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC.getState),
  action: (action: Action): Promise<ActionResult> => ipcRenderer.invoke(IPC.action, action),
  onState: (cb: (state: AppState) => void): (() => void) => {
    const handler = (_e: unknown, state: AppState) => cb(state);
    ipcRenderer.on(IPC.statePush, handler);
    return () => ipcRenderer.removeListener(IPC.statePush, handler);
  },
};

contextBridge.exposeInMainWorld('tq', api);

export type TqApi = typeof api;
