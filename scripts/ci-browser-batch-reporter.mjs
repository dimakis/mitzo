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
      let owner = test.parent;
      for (; owner?.type === 'describe'; owner = owner.parent)
        if (owner.title) titles.unshift(owner.title);
      if (owner?.type !== 'file' || !owner.location?.file)
        throw Error('Browser case has no owning spec file');
      const ownerFile = relative(config.rootDir, owner.location.file).replaceAll('\\', '/');
      // Playwright filters file loading by the owning spec, then case selection
      // by declaration location. Imported cases need both qualified entries.
      const qualify = (file) => `[${project}] › ${file} › ${titles.join(' › ')}`;
      return { id: test.id, project, selector: qualify(file), loadSelector: qualify(ownerFile) };
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
