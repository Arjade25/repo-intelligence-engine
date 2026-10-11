@ECHO off
REM Exposes ONLY madge to the bash-madge benchmark arm (see benchmarks/tools.json).
node "%~dp0..\..\..\node_modules\madge\bin\cli.js" %*
