const productionPath =
  /^(server|frontend\/(src|ios)|packages\/(client|harness|protocol)|mcp-server|scripts|infra)\//;
const productionRootFile = /^(package(?:-lock)?\.json|docker-compose(?:\.[\w-]+)?\.ya?ml)$/;
const testPath = /(^|\/)(__tests__|test|tests|fixtures|__mocks__)\/|\.(test|spec)\.[^.]+$/;
const placeholderException = /^(n\/?a|none|no|not applicable|explain why)\.?$/i;

export function isProductionPath(path) {
  return (
    Boolean(path) &&
    !testPath.test(path) &&
    (productionPath.test(path) || productionRootFile.test(path))
  );
}

function filePaths({ filename, previous_filename: previousFilename }) {
  return [filename, previousFilename].filter(Boolean);
}

export function evaluateDocumentationGate({ files, body }) {
  const changedPaths = files.flatMap(filePaths);
  const changesProductionCode = changedPaths.some(isProductionPath);
  const changesReadme = changedPaths.includes('README.md');
  const readmeReviewed = /- \[[xX]\] README (updated|reviewed)\b/m.test(body);
  const exception = body.match(/^README exception:\s*(.+)$/im)?.[1]?.trim();
  const validException =
    Boolean(exception) && exception.length >= 20 && !placeholderException.test(exception);
  const errors = [];

  if (!readmeReviewed) {
    errors.push('Complete the README review item in the pull-request template.');
  }

  if (changesProductionCode && !changesReadme && !validException) {
    errors.push(
      'This PR changes production code but does not update README.md. ' +
        'Update the README, or add a substantive "README exception:" explanation to the PR description.',
    );
  }

  return { ok: errors.length === 0, errors };
}
