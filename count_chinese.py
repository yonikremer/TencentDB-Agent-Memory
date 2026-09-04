import os, re
files = ['README.deployment.md', 'README.docker.md', 'README.md', 'ROADMAP.md', 'agents/README.md', 'agents/asset-import.ts', 'agents/claude-code/README.md', 'agents/claude-code/asset-import.md', 'agents/codebuddy/README.md', 'agents/codebuddy/asset-import.md', 'agents/codex/README.md', 'agents/codex/asset-import.md', 'agents/dsh/README.md', 'agents/dsh/asset-import.md', 'agents/hermes/README.md', 'agents/hermes/asset-import.md', 'agents/openclaw/README.md', 'agents/openclaw/asset-import.md', 'agents/opencode/README.md', 'agents/setup-proxy.sh', 'agents/skills/setup-proxy/SKILL.md', 'agents/skills/setup-proxy/setup-proxy.sh', 'agents/workbuddy/README.md', 'agents/workbuddy/asset-import.md', 'deploy/dockerhub/README.md', 'deploy/dockerhub/publish.sh', 'deploy/global-images/.env.example', 'deploy/global-images/README.md', 'deploy/global-images/_lib.sh', 'deploy/global-images/start-memory-core.sh', 'deploy/global-images/start-memory-hub.sh', 'deploy/global-images/start-proxy.sh', 'deploy/global-images/stop-all.sh', 'deploy/global-images/verify.sh', 'deploy/panel-knowledge-combined/.dockerignore', 'deploy/panel-knowledge-combined/Dockerfile', 'deploy/panel-knowledge-combined/README.md', 'deploy/panel-knowledge-combined/build.sh', 'deploy/panel-knowledge-combined/publish.sh', 'deploy/panel-knowledge-combined/start-combined.sh']
chinese_char_re = re.compile(r'[\u4e00-\u9fff]+')
for f in files:
    if os.path.exists(f):
        with open(f, 'r', encoding='utf-8') as fp:
            content = fp.readlines()
            count = sum(bool(chinese_char_re.search(line)) for line in content)
            if count > 0:
                print(f"{f}: {count} lines")
