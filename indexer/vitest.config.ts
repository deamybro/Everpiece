import { defineConfig } from "vitest/config";

// config.yaml takes the escrow address and start block from the environment; tests use fixed stand-ins.
export default defineConfig({
  test: {
    // Starting the test indexer from a Windows drive mounted in WSL (/mnt/c) takes minutes; on WSL's own disk, seconds.
    testTimeout: 180_000,
    env: {
      ENVIO_ESCROW_START_BLOCK: "1",
      ENVIO_BLOCK_LAG: "0",
      ENVIO_RPC_URL: "http://127.0.0.1:1",
      ENVIO_RPC_FOR: "sync",
      ENVIO_ESCROW_ADDRESS: "0x0000000000000000000000000000000000000001",
    },
  },
});
