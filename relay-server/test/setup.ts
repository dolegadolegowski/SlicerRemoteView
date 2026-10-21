import { defaultSchemas } from "@slicerremoteview/shared";

// Compile the protocol schemas once per test file, outside every test's timeout (≈ 250 ms).
defaultSchemas();
