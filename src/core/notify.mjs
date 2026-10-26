// Operator requests: a dated entry in operator/requests.md, a Windows toast, and an optional webhook.
// An entry stays open until someone changes its "- status: open" line to "- status: resolved".
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { nowSeoul } from './clock.mjs';
import { ensureDir } from './instance.mjs';

const TOAST_SCRIPT = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$x = $t.GetElementsByTagName('text')",
  "$x.Item(0).AppendChild($t.CreateTextNode($env:FSW_TOAST_TITLE)) > $null",
  "$x.Item(1).AppendChild($t.CreateTextNode($env:FSW_TOAST_BODY)) > $null",
  "$n = [Windows.UI.Notifications.ToastNotification]::new($t)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)",
].join('; ');

export function openDedupeKeys(markdown) {
  const open = new Set();
  for (const entry of markdown.split(/^## /m).slice(1)) {
    const key = entry.match(/^- dedupe: (.+)$/m)?.[1]?.trim();
    const status = entry.match(/^- status: (\S+)/m)?.[1];
    if (key && status !== 'resolved') open.add(key);
  }
  return open;
}

function toast(title, body) {
  if (process.platform !== 'win32') return false;
  try {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, FSW_TOAST_TITLE: String(title ?? ''), FSW_TOAST_BODY: String(body ?? '').slice(0, 240) },
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function post(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function notifyOperator(instance, { kind, title, body = '', url, dedupeKey }) {
  const dir = ensureDir(instance.paths.operator);
  const file = join(dir, 'requests.md');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (dedupeKey && openDedupeKeys(existing).has(dedupeKey)) return { written: false, toasted: false, posted: false };
  const now = nowSeoul();
  const lines = [
    `## ${now.ymd} ${now.hm} [${kind}] ${title}`,
    '',
    '- status: open',
    ...(dedupeKey ? [`- dedupe: ${dedupeKey}`] : []),
    ...(url ? [`- url: ${url}`] : []),
    '',
    ...(body ? [body, ''] : []),
  ];
  appendFileSync(file, (existing === '' ? '# Operator requests\n\n' : existing.endsWith('\n\n') ? '' : '\n') + lines.join('\n') + '\n');
  const notifyCfg = instance.config?.notify ?? {};
  const toasted = notifyCfg.toast ? toast(title, body) : false;
  const posted = notifyCfg.webhookUrl ? await post(notifyCfg.webhookUrl, { kind, title, body, url, dedupeKey, at: now.iso }) : false;
  return { written: true, toasted, posted };
}
