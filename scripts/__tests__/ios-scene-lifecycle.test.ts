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
  expect(
    readFileSync(`${app}Base.lproj/${scene.UISceneStoryboardFile}.storyboard`, 'utf8'),
  ).toContain('CAPBridgeViewController');
  const delegateClass = scene.UISceneDelegateClassName.split('.').at(-1);
  const source = readFileSync(`${app}AppDelegate.swift`, 'utf8');
  expect(source).toContain(`class ${delegateClass}: UIResponder, UIWindowSceneDelegate`);
  expect(source).toContain(
    'SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)',
  );
  expect(source).toContain('SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)');
  expect(source).toContain('SceneDelegateProxy.shared.scene(scene, continue: userActivity)');
});
