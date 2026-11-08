---
description: Check the current git changes for test tampering (skipped tests, deleted assertions, neutered CI)
allowed-tools: Bash(node:*)
---

Run goodhart on the working tree and report the result:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/goodhart.js" check --no-color --fail-on never`

Summarise the findings for the user. For each error, say whether the change looks like a legitimate
test update or like the tests were weakened to make them pass. Do not "fix" findings by editing the
tests further; if the implementation is wrong, propose fixing the implementation.
