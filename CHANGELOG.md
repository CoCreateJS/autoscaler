# [2.0.0](https://github.com/CoCreateJS/autoscaler/compare/v1.1.0...v2.0.0) (2026-11-02)


### Features

* align CoCreate repository and package naming ([4f54008](https://github.com/CoCreateJS/autoscaler/commit/4f54008114584ba543293b5701935c6f0302798a))


### BREAKING CHANGES

* consumers must use the renamed CoCreate package and repository identities; the previous prefixed names are no longer supported.

# [1.1.0](https://github.com/CoCreateJS/autoscaler/compare/v1.0.2...v1.1.0) (2026-11-02)


### Bug Fixes

* add Deno specific entries to .gitignore ([559533d](https://github.com/CoCreateJS/autoscaler/commit/559533d7562c401b401446bbee33caefe1b0bc06))
* add dependencies section to package.json ([5221fe1](https://github.com/CoCreateJS/autoscaler/commit/5221fe175a2c4170beabd5bc8a09feb3a8813b69))
* bump [@cocreate](https://github.com/cocreate) dependencies ([06abe78](https://github.com/CoCreateJS/autoscaler/commit/06abe78e1a52e4ad713db30ced4a07e9d11bb642))
* bump versions ([d0781f8](https://github.com/CoCreateJS/autoscaler/commit/d0781f8d09bf11ab4eba9b545251a508a93c0f13))
* correct import path for calculateOptimalGeoLocation function in index.js ([1d86441](https://github.com/CoCreateJS/autoscaler/commit/1d8644183430ba8b1aa72d1daadb6a5b266dde5d))
* instance renamed to vm ([22cb8e4](https://github.com/CoCreateJS/autoscaler/commit/22cb8e431e479de7a411117a3b75401cf0d8f5fe))
* isPrimary ([1cc6817](https://github.com/CoCreateJS/autoscaler/commit/1cc6817fde9b7307e63b53b52dca7f95e40f3bb3))
* missing dependencies ([178dab7](https://github.com/CoCreateJS/autoscaler/commit/178dab70f9a6e6de6092f585de0c36da5eed6d4a))
* refactor server context handling to use 'Master' terminology and improve initialization logic ([2d3090f](https://github.com/CoCreateJS/autoscaler/commit/2d3090fdfd765293bd387693919c83d3cdad2478))
* remove trailing slash from node_modules entry in .gitignore ([2786703](https://github.com/CoCreateJS/autoscaler/commit/2786703b79710be048c1d51e3b482c670b8b724f))
* replace legacy $filter field with filter ([63f1dc8](https://github.com/CoCreateJS/autoscaler/commit/63f1dc88a3f7fd1079e24f7f5876aba29da16500))
* reuse the cluster snapshot during scale-out ([f1d1c53](https://github.com/CoCreateJS/autoscaler/commit/f1d1c53a40f52696bc99f659e9598e9e7332b64e))
* simplify autoscale configuration retrieval in init function ([a4005b7](https://github.com/CoCreateJS/autoscaler/commit/a4005b7012ea924c7fc6f027ed7ed72ffc830971))
* update git url ([2068009](https://github.com/CoCreateJS/autoscaler/commit/20680099527141e3c9a4282408661a37ef7c5e8f))
* update GitHub Actions to use latest versions and sync package.json description ([9153738](https://github.com/CoCreateJS/autoscaler/commit/9153738153e3d7a568e617ff5941d018bfe87974))
* update initialization log message to indicate primary status and awaiting telemetry feed ([339bbf7](https://github.com/CoCreateJS/autoscaler/commit/339bbf7aa7062f8a008085cc4b251bff4269b876))


### Features

* Add comprehensive cloud region registry and utility functions ([c559766](https://github.com/CoCreateJS/autoscaler/commit/c5597669054c39bc57a54517823230ae420880ae))
* enhance autoscaler functionality with cloud provider loading and scaling logic ([9d66808](https://github.com/CoCreateJS/autoscaler/commit/9d66808a0e6941cddaf38b9023985cc0bf11882d))
* merge startup config into autoscaler defaults ([47e24ee](https://github.com/CoCreateJS/autoscaler/commit/47e24eede656c9430e310ef1dc2de88e8864c3b8))
* refactor autoscale configuration loading to use dot notation and improve structure ([a5fd9ac](https://github.com/CoCreateJS/autoscaler/commit/a5fd9ac8d9c9230caec414d2bf48371267ab0ddb))
* refactor autoscale configuration structure and improve loading logic ([1bf8da7](https://github.com/CoCreateJS/autoscaler/commit/1bf8da709f9343b456ed19462c8fb5997a85f0f3))
* Refactor autoscaling logic to enhance scaling thresholds and introduce vertical tiering ([652d690](https://github.com/CoCreateJS/autoscaler/commit/652d690277b63870b9e03588f1bc9f69039facf2))
* Refactor geo scaling logic and introduce cloud provider selection ([a1a28fd](https://github.com/CoCreateJS/autoscaler/commit/a1a28fdd343c180f789d87bbf3f9478c9ad9e0a4))

## [1.0.2](https://github.com/CoCreateJS/autoscaler/compare/v1.0.1...v1.0.2) (2026-07-19)


### Bug Fixes

* set default branch to main ([e07409f](https://github.com/CoCreateJS/autoscaler/commit/e07409f30538c1afcadb4a584a19ad077bda54bd))

## [1.0.1](https://github.com/CoCreateJS/autoscaler/compare/v1.0.0...v1.0.1) (2026-07-17)


### Bug Fixes

* bump dependencies ([6a262b6](https://github.com/CoCreateJS/autoscaler/commit/6a262b6c9483c171f53275f13313fd3aed015653))

# 1.0.0 (2026-07-17)


### Features

* Add release configuration for semantic release automation ([a5a60ed](https://github.com/CoCreateJS/autoscaler/commit/a5a60ed1c19f1ec02ac3b1416c7b048937c5a999))
* Enhance scaling action with simulation mode and improved error handling ([c3d694c](https://github.com/CoCreateJS/autoscaler/commit/c3d694c9b2105f4edd6b1279ef9ba970d93c1454))
* Initial  Release ([cb44226](https://github.com/CoCreateJS/autoscaler/commit/cb44226bf0955c3759800bdf55db37408025ca54))
