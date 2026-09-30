# qzjs — 命令入口
#
# 常用：
#   make build      配置 + 编译 Release（-DQZ_BUILD_EXAMPLES=ON）→ build/qzjs qzc qzjs-rt
#   make qzjs       运行 qzjs CLI（make qzjs ARGS='-e "console.log(1)"'）
#   make run        同上（alias）
#   make qzc        用 qzc 编译 JS → 字节码（make qzc SRC=app.js OUT=app.bc）
#   make bc         qzc 编译 + qzjs --bytecode 运行（SRC=app.js [ARGS='...']）
#   make example    make example NAME=fs     运行某个 JS example
#   make grpc       QZ_WITH_GRPC=ON 构建（build_grpc）+ 跑 grpc-hello
#   make test       构建测试套件并跑 ctest
#   make test-offline  只跑 offline 标签（fresh clone 缺 test262 时的正确默认）
#   make docs       构建文档站（docs/.vitepress/dist）
#   make docs-dev   VitePress dev server
#   make verify     全套本地验证（= CI 在本地跑的那些东西，见该目标注释）
#   make asan       ASan+LSan 的测试套件（ctest，tests=ON）
#   make asan-rt    ASan+LSan 的真实 ISOLATED 构建（tests=OFF，含两个端点探针）
#   make ubsan      UBSan 的测试套件（tests=ON）
#   make gates      四个静态门：文档 C 片段 / 站内链接 / 声明面(3 档) / CI YAML
#   make clean      删除全部构建目录

BUILD_DIR   ?= build
GRPC_DIR    ?= build_grpc
DOCS_DIR    ?= docs
CMAKE       ?= cmake
BUILD_TYPE  ?= Release

.PHONY: all build qzjs run qzc bc example grpc test test-offline docs docs-dev \
        verify asan asan-rt ubsan gates clean

all: build

## 配置 + 编译（Release，含 examples）→ build/qzjs qzc qzjs-rt
build:
	$(CMAKE) -B $(BUILD_DIR) -G Ninja -DCMAKE_BUILD_TYPE=$(BUILD_TYPE) -DQZ_BUILD_EXAMPLES=ON
	$(CMAKE) --build $(BUILD_DIR) --parallel

## 运行 qzjs CLI（make qzjs ARGS='-e "console.log(1)"' 或 make qzjs ARGS='script.js'）
qzjs:
	$(CMAKE) --build $(BUILD_DIR) --parallel
	./$(BUILD_DIR)/qzjs $(ARGS)

## 运行 qzjs CLI（alias）
run: qzjs

## qzc 编译 JS → 字节码（make qzc SRC=app.js [OUT=app.bc]；缺省 <SRC>.bc）
qzc:
	@test -n "$(SRC)" || { echo "usage: make qzc SRC=app.js [OUT=app.bc]"; exit 2; }
	$(CMAKE) --build $(BUILD_DIR) --target qz_qzc --parallel
	./$(BUILD_DIR)/qzc $(SRC) $(if $(OUT),-o $(OUT))

## qzc 编译 + qzjs --bytecode 运行（make bc SRC=app.js [ARGS='a b']）
bc: qzc
	./$(BUILD_DIR)/qzjs --bytecode $(if $(OUT),$(OUT),$(SRC:.js=.bc)) $(ARGS)

## 运行某个 JS example（make example NAME=fs；C 示例是独立可执行文件）
example: build
	./$(BUILD_DIR)/qzjs examples/$(NAME)/$(NAME).js

## QZ_WITH_GRPC=ON 构建（build_grpc）+ 跑 grpc-hello 四形态
grpc:
	$(CMAKE) -B $(GRPC_DIR) -G Ninja -DCMAKE_BUILD_TYPE=$(BUILD_TYPE) -DQZ_WITH_GRPC=ON
	$(CMAKE) --build $(GRPC_DIR) --target qz_cli qz_rt --parallel
	./$(GRPC_DIR)/qzjs examples/grpc-hello/grpc-hello.js

## 构建测试套件并跑全部测试（含 test262；fresh clone 请用 test-offline）
test:
	$(CMAKE) -B $(BUILD_DIR) -G Ninja -DCMAKE_BUILD_TYPE=$(BUILD_TYPE) -DQZ_BUILD_TESTS=ON
	$(CMAKE) --build $(BUILD_DIR) --parallel
	cd $(BUILD_DIR) && ctest --output-on-failure

## 只跑 offline 标签测试（fresh clone 的正确默认：test262 corpus 未初始化）
test-offline:
	$(CMAKE) -B $(BUILD_DIR) -G Ninja -DCMAKE_BUILD_TYPE=$(BUILD_TYPE) -DQZ_BUILD_TESTS=ON
	$(CMAKE) --build $(BUILD_DIR) --parallel
	cd $(BUILD_DIR) && ctest -L offline --output-on-failure

## 构建文档站（docs/.vitepress/dist）
docs:
	npm ci --prefix $(DOCS_DIR)
	npm run build --prefix $(DOCS_DIR)

## VitePress dev server（本地预览）
docs-dev:
	npm run dev --prefix $(DOCS_DIR)

# ── 验证矩阵 ────────────────────────────────────────────────────────────────
# 为什么要有这些目标：这些构建配置之前**只存在于 CI yaml 里**，本地验证全靠手敲
# cmake 命令，配置对不对全凭记忆。代价是真实的——我按「我本地跑过 ASAN」的说法放过
# 一次堆 use-after-free（FaultGuard 析构写已释放的 rt），原因是我手上的
# build-asan 是 tests=OFF（压根不编译 gtest，ctest 报 "No tests were found!!!"），
# 而唯一带 tests=ON 的那个是 UBSAN（抓不到堆 UAF）。**CI 早就会红，红的是我没复现
# CI 的验证条件。** 所以把矩阵搬进 Makefile：配置写死在这里，跑哪个是人的选择。
#
# 这几个目录归本 Makefile 所有（build_asan / build_asan_rt / build_ubsan /
# build_thread）。若某个目录此前是用**别的生成器或别的手敲 cmake 命令**建的，
# CMake 会报 "Does not match the generator used previously" —— 那不是本 Makefile
# 的 bug，直接 rm -rf 那个目录重跑即可。
#
# 三套是刻意分开的，形态不同覆盖的东西也不同，别指望一套顶三套：
#   asan     tests=ON + ASan/LSan  → 覆盖 gtest 路径（mock 库 + 全部 *_gtest）
#   asan-rt  tests=OFF + ASan/LSan → 覆盖**真实 ISOLATED 并发路径**（rt_host.c 只在
#            ISOLATED && !mock 下编入，tests=ON 那一套里整文件是不编的）
#   ubsan    tests=ON + UBSan      → 覆盖未定义行为
ASAN_FLAGS  = -fsanitize=address -fno-omit-frame-pointer -g
ASAN_OPTS   = detect_leaks=1:detect_stack_use_after_return=0
# 精简扩展档：与 ci.yml 的 asan job 保持一致，少编 wasm/tls 换取构建时间
LEAN_EXT    = -DQZ_WITH_WAMR=OFF -DQZ_WITH_TLS=OFF -DQZ_WITH_CRYPTO_EXT=OFF -DQZ_WITH_COMPRESS=OFF -DQZ_WITH_TEXTCODEC=OFF

## ASan+LSan 测试套件（tests=ON）
asan:
	$(CMAKE) -B build_asan -G Ninja -DCMAKE_BUILD_TYPE=Debug -DQZ_BUILD_TESTS=ON \
	  $(LEAN_EXT) -DCMAKE_C_FLAGS="$(ASAN_FLAGS)" -DCMAKE_CXX_FLAGS="$(ASAN_FLAGS)" \
	  -DCMAKE_EXE_LINKER_FLAGS=-fsanitize=address
	$(CMAKE) --build build_asan --parallel
	cd build_asan && ASAN_OPTIONS=$(ASAN_OPTS) ctest -E test262 --output-on-failure

## ASan+LSan 真实 ISOLATED 构建（tests=OFF）+ M-P7 e2e + 两个端点探针
asan-rt:
	$(CMAKE) -B build_asan_rt -G Ninja -DCMAKE_BUILD_TYPE=Debug -DQZ_BUILD_TESTS=OFF \
	  -DQZ_BUILD_CLI=ON -DQZ_BUILD_EXAMPLES=ON $(LEAN_EXT) \
	  -DCMAKE_C_FLAGS="$(ASAN_FLAGS)" -DCMAKE_EXE_LINKER_FLAGS=-fsanitize=address
	$(CMAKE) --build build_asan_rt --parallel
	bash test/test_mp7_mailbox_e2e.sh ./build_asan_rt/qzjs
	cd build_asan_rt && ASAN_OPTIONS=$(ASAN_OPTS) ./qz_ctl_endpoint_leak_probe
	cd build_asan_rt && ASAN_OPTIONS=$(ASAN_OPTS) ./qz_ctl_reject_frames_probe

## UBSan 测试套件（tests=ON）
ubsan:
	$(CMAKE) -B build_ubsan -G Ninja -DCMAKE_BUILD_TYPE=Debug -DQZ_BUILD_TESTS=ON \
	  $(LEAN_EXT) -DCMAKE_C_FLAGS="-fsanitize=undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer -g" \
	  -DCMAKE_CXX_FLAGS="-fsanitize=undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer -g" \
	  -DCMAKE_EXE_LINKER_FLAGS=-fsanitize=undefined
	$(CMAKE) --build build_ubsan --parallel
	cd build_ubsan && ctest -E test262 --output-on-failure

## 五个静态门。声明面那一门要三套库都存在（isolated/thread/mock），缺哪套就报哪套。
# fuzz 语料对齐门不需要构建（它比对 test/fuzz-corpus/*.bc 与 src/*_default.c 里的
# 真实字节码），所以放在最前面，任何时候都能单独跑。
gates:
	python3 test/docs_c_snippet_check.py --ratchet
	python3 test/docs_link_check.py
	python3 test/fuzz_corpus_align_check.py
	@for m in "isolated build_rt" "thread build_thread" "mock build"; do \
	  set -- $$m; \
	  if [ -f "$$2/libqzjs.a" ]; then \
	    python3 test/api_surface_check.py --build-dir "$$2" --model "$$1" || exit 1; \
	  else \
	    echo "SKIP api_surface $$1：$$2/libqzjs.a 不存在（先 make build_rt / build_thread / test）"; \
	  fi; \
	done
	python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml YAML OK')"

## 全套本地验证：门 + 离线测试 + e2e + 示例 + 三套 sanitizer 矩阵
verify: gates
	$(CMAKE) -B $(BUILD_DIR) -G Ninja -DCMAKE_BUILD_TYPE=$(BUILD_TYPE) -DQZ_BUILD_TESTS=ON
	$(CMAKE) --build $(BUILD_DIR) --parallel
	cd $(BUILD_DIR) && ctest -L offline --output-on-failure
	$(CMAKE) -B build_rt -G Ninja -DCMAKE_BUILD_TYPE=$(BUILD_TYPE) -DQZ_BUILD_TESTS=OFF \
	  -DQZ_BUILD_CLI=ON -DQZ_BUILD_EXAMPLES=ON
	$(CMAKE) --build build_rt --parallel
	@for s in test_mp1_process_e2e test_mp2_host_split_e2e test_mp3_port_e2e \
	         test_mp4_storage_crash_e2e test_ctl_e2e test_mr2_composition_e2e \
	         test_nested_e2e test_mp7_mailbox_e2e test_host_contract_e2e; do \
	  printf '%-32s ' "$$s"; \
	  bash test/$$s.sh ./build_rt/qzjs >/dev/null 2>&1 && echo PASS || { echo FAIL; exit 1; }; \
	done
	@for e in hello messages worker; do \
	  printf '%-10s ' "$$e"; ./build_rt/examples/$$e/qz_$$e >/dev/null 2>&1 && echo PASS || { echo FAIL; exit 1; }; \
	done
	$(MAKE) asan
	$(MAKE) ubsan

## 清理构建产物
clean:
	rm -rf $(BUILD_DIR) $(GRPC_DIR) build_thread build_asan build_asan_rt build_ubsan build_rt
