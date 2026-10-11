#!/bin/sh
# GitCharm credential prompt. Git executes this file (Git for Windows ships its
# own sh, macOS/Linux have it natively); it runs the bundled node entry through
# the extension host binary and echoes the answer on stdout.
"${GITCHARM_ASKPASS_NODE}" "${GITCHARM_ASKPASS_MAIN}" "$@"
