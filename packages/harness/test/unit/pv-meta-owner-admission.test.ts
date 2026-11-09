import assert from "node:assert/strict";
import {test} from "node:test";
import {ConfigError,loadConfig} from "../../src/config/index.ts";

const base={VERTIGO_META_SPEC_ROOT:"https://example.invalid/root",HARNESS_ENV:"fixture",PRINCIPALS_FILE:"fixture.json"};
test("META status admission is an empty server-owned allowlist unless explicitly configured",()=>{
  assert.deepEqual(loadConfig(base).metaRecoveryStatusPrincipalIds,[]);
  assert.deepEqual(loadConfig({...base,HARNESS_META_RECOVERY_STATUS_PRINCIPALS:'["p-fixture-owner"]'}).metaRecoveryStatusPrincipalIds,["p-fixture-owner"]);
});
test("META status admission rejects malformed or broad allowlists rather than widening the rollout",()=>{
  for(const value of ['*','["*"]','null','{}','[1]','[""]','[" owner "]','["p-one","p-two"]']){
    assert.throws(()=>loadConfig({...base,HARNESS_META_RECOVERY_STATUS_PRINCIPALS:value}),ConfigError,value);
  }
  assert.deepEqual(loadConfig({...base,HARNESS_META_RECOVERY_STATUS_PRINCIPALS:'[]'}).metaRecoveryStatusPrincipalIds,[]);
});
