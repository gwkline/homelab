# Stand-in for the loop-agent image in the panel e2e (via PANEL_LOOP_IMAGE):
# runs $LOOP_COMMAND exactly like apps/loop-agent/run-loop.sh does.
# Exec form defers the expansion to container start, after env injection.
FROM busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
ENTRYPOINT ["/bin/sh", "-c", "exec /bin/sh -c \"$LOOP_COMMAND\""]
