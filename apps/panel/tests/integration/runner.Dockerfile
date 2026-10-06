# Stand-in for the loop-agent image in the panel e2e (issue #27): the test
# cluster's panel pod runs with PANEL_LOOP_IMAGE pointed at this image, so a
# launched Job pulls a real, locally-loaded image and executes $LOOP_COMMAND
# exactly like apps/loop-agent/run-loop.sh does (sh -c "$LOOP_COMMAND") —
# proving the terminal-state transition without the private loop-agent image.
# Exec-form ENTRYPOINT keeps the expansion at container start, after the
# kubelet injects the panel's env; the quoted expansion hands the raw command
# text to a single inner shell, matching run-loop's `sh -c "${LOOP_COMMAND}"`.
FROM busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
ENTRYPOINT ["/bin/sh", "-c", "exec /bin/sh -c \"$LOOP_COMMAND\""]
