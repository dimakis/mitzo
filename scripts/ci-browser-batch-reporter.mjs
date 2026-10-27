import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import process from 'node:process';

// Added through --add-reporter, retaining list, HTML and immediate failures.
export default class BrowserBatchReporter {
  report = { tests: [], results: [], errors: 0, ended: false, status: null, pid: process.pid };
  save() {
    const path = process.env.MITZO_BROWSER_BATCH_REPORT;
    if (!path) throw Error('Select a browser batch evidence path');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.report, null, 2) + '\n');
  }
  onBegin(config, suite) {
    this.report.tests = suite.allTests().map((test) => {
      const project = test.parent.project()?.name ?? '';
      const file = relative(config.rootDir, test.location.file).replaceAll('\\', '/');
      const titles = [test.title];
      for (let parent = test.parent; parent?.type === 'describe'; parent = parent.parent)
        titles.unshift(parent.title);
      return { id: test.id, project, selector: `[${project}] › ${file} › ${titles.join(' › ')}` };
    });
    this.save();
  }
  onTestEnd(test, result) {
    this.report.results.push({
      id: test.id,
      status: result.status,
      expectedStatus: test.expectedStatus,
    });
    this.save();
  }
  onError() {
    this.report.errors++;
    this.save();
  }
  onEnd(result) {
    this.report.ended = true;
    this.report.status = result.status;
    this.save();
  }
}
