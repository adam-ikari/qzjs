import * as vscode from 'vscode';
import { QzjsDebugSession } from './adapter/qzjsDebugSession';
import { QzjsDebugAdapterDescriptorFactory } from './adapter/descriptorFactory';

export function activate(context: vscode.ExtensionContext) {
  const factory = new QzjsDebugAdapterDescriptorFactory();
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('qzjs', factory),
    factory,
  );
}

export function deactivate() {
  // nothing to clean up; factory handles child teardown per-session
}
