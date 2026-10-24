// fsw learn: turn new outcome cases into lessons, then refresh the playbook and the learned gate rules.
import { loadInstance } from '../core/instance.mjs';
import { writeLessons } from '../learning/lessons.mjs';
import { refreshPlaybook } from '../learning/playbook.mjs';

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const instance = ctx.instance ?? loadInstance();
  const opts = ctx.runCodex ? { runCodex: ctx.runCodex } : {};
  const lessons = await writeLessons(instance, opts);
  log('lessons: ' + lessons.lessons.length + ' (' + lessons.newCases + ' new cases)');
  const pb = await refreshPlaybook(instance, opts);
  log('gate rules: ' + pb.rules.length + (pb.rejected.length ? ', refused ' + pb.rejected.map((r) => r.class + ' (' + r.reason + ')').join(', ') : ''));
  log('playbook ' + (pb.playbookChanged ? 'rewritten' : 'unchanged'));
  return 0;
}
