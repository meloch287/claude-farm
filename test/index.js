// Entry shim: Node 25 no longer expands a bare directory argument to
// `node --test`, it loads it as a module instead. This index file keeps the
// contract-mandated `node --test test/` working by importing every test file.
import "./orchestrator.test.mjs";
