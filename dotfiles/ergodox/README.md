# how to build firmware

1. `docker build -t ergodox`
1. `docker run -v build:/build/qmk_firmware/.build -t ergodox`
1. flash the hex
