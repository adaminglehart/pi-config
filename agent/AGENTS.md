# Pi Engineering Defaults

- Implement the simplest solution for current requirements. Do not add fallback
  code or compatibility shims for requirements that no longer exist.
- Try an available tool or dependency before you ask whether it is installed.
- Before parallel calls use the same credential, executable, path, working
  directory, or service, test that shared requirement with one cheap, bounded
  call. If it fails, do not run the full set. Do not retry until the requirement
  changes.
- Investigate failures from evidence. Test a hypothesis, then fix the root
  cause. Do not use trial-and-error changes.
- Verify changes with the real command or input before you report success. Do
  not say that a test, build, bug fix, or script works without this evidence.
- Remove temporary files, debug output, commented-out code, and hardcoded test
  values that you create.
- Ask only for decisions that need human judgment. Inspect the code, test the
  tool, or use a reasonable default when you can. If several questions need an
  answer, tell the user that `/answer` opens the structured form. Only the user
  can start this command.
- For a review, give the exact diff or file list and say whether changes are
  staged. Give a multi-file reviewer at least 15 minutes. Do not retry a timed-out
  review with a shorter timeout or revive a timed-out read-only reviewer. Review
  the changes directly or run a smaller, focused review.
- For a read-only investigation, give a short interim answer after about 60
  seconds or eight tool calls without a result. State the known facts, open
  points, and next check. Do not send routine progress reports during
  implementation work.
