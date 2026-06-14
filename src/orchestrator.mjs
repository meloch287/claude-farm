// Orchestrator for "Клауд Ферма": drives a task through the zones,
// lets testers bounce it back, gives up after config.maxAttempts.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a farm bound to a config, a runners pair and an event bus.
 * @param {{zones: Array<{id: string, title: string, driver: {id: string, name: string}, tester: {id: string, name: string}}>, maxAttempts: number, stepDelayMs?: number}} config
 * @param {{runDriver(zoneId: string, ctx: object): Promise<any>, runTester(zoneId: string, ctx: object): Promise<{ok: boolean, note?: string, reason?: string, bounceTo?: string}>}} runners
 * @param {{emit(partialEvent: object): object}} bus
 * @returns {{runTask({id, title, input, config}: {id?: string, title: string, input: string, config?: object}): Promise<{ok: boolean, task: object, data: object}>}}
 */
export function createFarm(config, runners, bus) {
  let taskCounter = 0;

  // Optional pacing between steps so the dashboard animation is visible.
  async function step() {
    if (config.stepDelayMs > 0) {
      await sleep(config.stepDelayMs);
    }
  }

  async function runTask(spec) {
    const { title, input } = spec;
    // Honor an external id (the task store passes its own) so farm events
    // carry the store id; otherwise keep the internal counter.
    const taskId = spec.id ?? 't' + ++taskCounter;
    const ctx = {
      // task.config: per-task effective config (model, mode, subagents) —
      // runners read it to pick models and the ultracode plan. cwd/files carry
      // the board form's «Рабочая папка» and attached context files.
      task: {
        id: taskId,
        title,
        input,
        attempts: 1,
        config: spec.config,
        cwd: spec.cwd,
        files: spec.files,
      },
      data: {},
      config,
    };
    const zones = config.zones;

    bus.emit({
      type: 'task.created',
      taskId,
      message: `Задача «${title}» поступила на ферму`,
    });
    await step();

    let i = 0;
    while (i < zones.length) {
      const zone = zones[i];

      bus.emit({
        type: 'zone.enter',
        taskId,
        zone: zone.id,
        message: `Задача переходит в зону «${zone.title}»`,
      });
      await step();

      // --- driver phase ---
      bus.emit({
        type: 'driver.start',
        taskId,
        zone: zone.id,
        role: 'driver',
        message: `${zone.driver.name} приступает к работе`,
      });
      await step();

      const driverResult = await runners.runDriver(zone.id, ctx);
      bus.emit({
        type: 'driver.done',
        taskId,
        zone: zone.id,
        role: 'driver',
        message: driverResult?.message ?? `${zone.driver.name} закончил работу`,
      });
      await step();

      // --- tester phase ---
      bus.emit({
        type: 'tester.start',
        taskId,
        zone: zone.id,
        role: 'tester',
        message: `${zone.tester.name} проверяет результат`,
      });
      await step();

      const verdict = await runners.runTester(zone.id, ctx);

      if (verdict.ok) {
        bus.emit({
          type: 'tester.ok',
          taskId,
          zone: zone.id,
          role: 'tester',
          message: verdict.note
            ? `${zone.tester.name}: всё чисто. ${verdict.note}`
            : `${zone.tester.name}: всё чисто, пропускаю дальше`,
        });
        await step();
        i += 1;
        continue;
      }

      // Tester bounced the task back to an earlier zone.
      const bounceIndex = zones.findIndex((z) => z.id === verdict.bounceTo);
      const bounceZone = bounceIndex >= 0 ? zones[bounceIndex] : zones[0];

      bus.emit({
        type: 'tester.bounce',
        taskId,
        zone: zone.id,
        role: 'tester',
        message: `${zone.tester.name} нашёл баг: ${verdict.reason}. Задача возвращается в зону «${bounceZone.title}»`,
      });
      await step();

      ctx.task.attempts += 1;
      if (ctx.task.attempts > config.maxAttempts) {
        bus.emit({
          type: 'task.failed',
          taskId,
          zone: zone.id,
          message: `Задача «${title}» провалена: попытки закончились (${config.maxAttempts})`,
        });
        return { ok: false, task: ctx.task, data: ctx.data };
      }

      i = bounceIndex >= 0 ? bounceIndex : 0;
    }

    bus.emit({
      type: 'task.done',
      taskId,
      message: `Задача «${title}» готова! Попыток: ${ctx.task.attempts}`,
    });
    return { ok: true, task: ctx.task, data: ctx.data };
  }

  return { runTask };
}
