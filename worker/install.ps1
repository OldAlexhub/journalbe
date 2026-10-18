$ErrorActionPreference = 'Stop'
$ServerRoot = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $ServerRoot '.venv'
python -m venv $Venv
$Python = Join-Path $Venv 'Scripts\python.exe'
& $Python -m pip install --upgrade pip
& $Python -m pip install -r (Join-Path $PSScriptRoot 'requirements.lock')
& $Python -c "import spacy; nlp=spacy.load('en_core_web_sm'); assert 'transformer' not in nlp.pipe_names; print(nlp.meta['name'], nlp.meta['version'], nlp.pipe_names)"
