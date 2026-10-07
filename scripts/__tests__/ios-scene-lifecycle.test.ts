import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const app = fileURLToPath(new URL('../../frontend/ios/App/App/', import.meta.url));

it('declares a launchable scene for the storyboard bridge on iOS 27', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))',
      `${app}Info.plist`,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  const plist = JSON.parse(result.stdout);
  const scenes =
    plist.UIApplicationSceneManifest?.UISceneConfigurations?.UIWindowSceneSessionRoleApplication;
  expect(scenes, 'iOS 27 refuses to launch apps without a scene configuration').toHaveLength(1);
  expect(plist.UIApplicationSceneManifest.UIApplicationSupportsMultipleScenes).toBe(false);
  const scene = scenes[0];
  expect(scene.UISceneStoryboardFile).toBe('Main');
  const storyboard = readFileSync(
    `${app}Base.lproj/${scene.UISceneStoryboardFile}.storyboard`,
    'utf8',
  );
  const delegateClass = scene.UISceneDelegateClassName.split('.').at(-1);
  const source = readFileSync(`${app}AppDelegate.swift`, 'utf8');
  const controller = storyboard.match(/customClass="(\w+)" customModule="(\w+)"/);
  expect(
    controller,
    'The storyboard must instantiate a Capacitor bridge or a compiled subclass',
  ).not.toBeNull();
  if (controller![1] === 'CAPBridgeViewController') {
    expect(controller![2]).toBe('Capacitor');
  } else {
    expect(controller![2]).toBe('App');
    expect(source).toMatch(new RegExp(`class ${controller![1]}:\\s*CAPBridgeViewController`));
  }
  expect(source).toContain(`class ${delegateClass}: UIResponder, UIWindowSceneDelegate`);
  expect(source).toContain(
    'SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)',
  );
  expect(source).toContain('SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)');
  expect(source).toContain('SceneDelegateProxy.shared.scene(scene, continue: userActivity)');
});

it('installs an app-owned notification delegate before a cold background launch finishes', () => {
  const source = readFileSync(`${app}AppDelegate.swift`, 'utf8');
  const launch = source.match(
    /func application\([^]*?didFinishLaunchingWithOptions[^]*?return true/,
  );
  expect(
    launch,
    'A notification-action launch must install its delegate without a scene',
  ).not.toBeNull();
  const assigned = launch![0].match(/UNUserNotificationCenter\.current\(\)\.delegate = (\w+)/);
  expect(assigned, 'The delegate must be assigned before launch returns').not.toBeNull();
  const properties = source.slice(
    source.indexOf('class AppDelegate'),
    source.indexOf('func application('),
  );
  expect(properties, 'The app must retain the delegate independently of a view controller').toMatch(
    new RegExp(`(?:let|var) ${assigned![1]}\\s*=`),
  );
});
