import 'dotenv/config';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requirements = path.join(serverRoot, 'worker', 'requirements.lock');
const defaultEnvironment = path.join(serverRoot, '.venv');
const defaultPython = path.join(
  defaultEnvironment,
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
);
const configuredPython = String(process.env.PYTHON_BIN || '').trim();
const configuredPythonPath = configuredPython
  ? (path.isAbsolute(configuredPython) ? configuredPython : path.resolve(serverRoot, configuredPython))
  : '';
const runtimePython = configuredPythonPath && existsSync(configuredPythonPath)
  ? configuredPythonPath
  : defaultPython;
const model = String(process.env.NLP_MODEL || 'en_core_web_sm').trim();

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: serverRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  return result;
}

function successful(result) {
  return !result.error && result.status === 0;
}

function findBootstrapPython() {
  const override = String(process.env.PYTHON_BOOTSTRAP_BIN || '').trim();
  const candidates = override
    ? [{executable: override, prefix: []}]
    : process.platform === 'win32'
      ? [
          {executable: 'py', prefix: ['-3.12']},
          {executable: 'py', prefix: ['-3.11']},
          {executable: 'python', prefix: []},
        ]
      : [
          {executable: 'python3.12', prefix: []},
          {executable: 'python3.11', prefix: []},
          {executable: 'python3', prefix: []},
        ];

  for (const candidate of candidates) {
    const probe = run(candidate.executable, [
      ...candidate.prefix,
      '-c',
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
    ]);
    if (successful(probe) && ['3.11', '3.12'].includes(probe.stdout.trim())) return candidate;
  }
  throw new Error('Python 3.11 or 3.12 is required to initialize the text worker');
}

function environmentRootFor(pythonPath) {
  const executable = path.basename(pythonPath).toLowerCase();
  const binFolder = path.basename(path.dirname(pythonPath)).toLowerCase();
  if (
    (process.platform === 'win32' && executable === 'python.exe' && binFolder === 'scripts') ||
    (process.platform !== 'win32' && executable === 'python' && binFolder === 'bin')
  ) {
    return path.dirname(path.dirname(pythonPath));
  }
  return null;
}

function validateWorker() {
  const validation = run(runtimePython, [
    '-c',
    [
      'import json, os, spacy',
      'nlp = spacy.load(os.environ["NLP_MODEL"])',
      'assert "transformer" not in nlp.pipe_names',
      'print(json.dumps({"model": nlp.meta.get("name"), "version": nlp.meta.get("version"), "pipes": nlp.pipe_names}))',
    ].join('; '),
  ], {env: {...process.env, NLP_MODEL: model}});
  return validation;
}

try {
  if (!model) throw new Error('NLP_MODEL cannot be empty');
  if (configuredPythonPath && !existsSync(configuredPythonPath)) {
    console.log('Configured PYTHON_BIN was not found; using the managed text-worker environment.');
  }

  if (!existsSync(runtimePython)) {
    const environmentRoot = environmentRootFor(runtimePython);
    if (!environmentRoot) {
      throw new Error('PYTHON_BIN does not exist and is not a supported virtual-environment path');
    }
    const bootstrap = findBootstrapPython();
    console.log('Initializing the private text-worker environment...');
    const created = run(bootstrap.executable, [...bootstrap.prefix, '-m', 'venv', environmentRoot]);
    if (!successful(created)) throw new Error(created.stderr.trim() || 'Unable to create the text-worker environment');
  }

  let validation = validateWorker();
  if (!successful(validation)) {
    console.log('Installing the pinned text model and worker dependencies...');
    const installed = run(runtimePython, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', requirements,
    ], {stdio: 'inherit'});
    if (!successful(installed)) throw new Error('Unable to install text-worker dependencies');
    validation = validateWorker();
  }

  if (!successful(validation)) {
    throw new Error(validation.stderr.trim() || `Unable to load configured text model ${model}`);
  }
  const details = JSON.parse(validation.stdout.trim());
  console.log(`Text worker ready: ${details.model} ${details.version}.`);
} catch (error) {
  console.error(`Text worker setup failed: ${error.message}`);
  process.exitCode = 1;
}
