import * as vscode from 'vscode';
import { OUTPUT_CHANNEL_NAME } from './config';

let _channel: vscode.OutputChannel | null = null;

// Console fallback used when running outside the VS Code host (e.g., vitest)
const consoleChannel: vscode.OutputChannel = {
  name: OUTPUT_CHANNEL_NAME,
  append: (value: string) => process.stdout.write(value),
  appendLine: (value: string) => console.log(`[${OUTPUT_CHANNEL_NAME}] ${value}`),
  replace: (value: string) => console.log(value),
  clear: () => {},
  show: () => {},
  hide: () => {},
  dispose: () => {},
};

export function initLogger(channel: vscode.OutputChannel): void {
  _channel = channel;
}

export function getLogger(): vscode.OutputChannel {
  return _channel ?? consoleChannel;
}
