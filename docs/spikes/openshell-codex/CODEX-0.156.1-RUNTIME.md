# Codex 0.156.1 isolated runtime measurement

This is an additional exact-image contract for fresh Symposium seats. Existing images remain accepted for their existing resources. The disposable local Podman image was inspected on 30 September 2026 without credentials, network access, or a model call.

| Property                                                   | Exact value                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| OCI image ID                                               | `sha256:f3f1f3e6ad517a2055f2a6c3d56f7a03514038abcd8909cc686cc02e3ea96e5f` |
| Podman manifest digest                                     | `sha256:5bf7f4452c8593b798932bf33d88c7d4f7a02d9a12a6c9d99b467b50fa6232ae` |
| `codex --version`                                          | `codex-cli 0.156.1`                                                       |
| `/usr/bin/codex` SHA-256                                   | `876fe6bb5f7af7d1e4eda629be0d8ba042f6f24a7bb07475f6a995849f50c068`        |
| `/usr/bin/codex-code-mode-host` SHA-256                    | `b22553f5085d1b2ad5b1d5e935bb8974e2e76d925df1fc30fa83f67bfe216623`        |
| `/usr/local/bin/symposium-seat-landlock` SHA-256           | `bf31950c31eafab27d54ddd3662e450769811ea906687616217d743d3134c96d`        |
| `/usr/local/bin/symposium-attempt-controller` SHA-256      | `d9f995cd0871ca63be4efa3c5d5760094af9c07496e1acf5d838acf8b55f2209`        |
| `/usr/local/bin/symposium-subscription-app-server` SHA-256 | `ffb14857502305d354143e475ad8b417aa733857254b6d3e34b66023e444adfb`        |

The committed normalization source has the same SHA-256 as `/usr/local/bin/normalize-symposium-codex.py` in the image: `ae0c34416585d6e6e0e504e445f206a445ce463583747c7653387d8dac67b9da`. Its `--check` passed inside a disposable container. The offline Landlock canary passed private HOME, shared workspace, read-only, symlink, and `/proc` checks. The production gate still verifies every image and native artifact hash before dispatch; this measurement does not activate the image or change production configuration.

The fresh Personal model catalog separately reported `gpt-6-luna` with low reasoning effort on `dimitri.saridakis@gmail.com` Personal Pro. A future isolated stage must refresh that catalog again before selecting it. This image measurement made no model call.
