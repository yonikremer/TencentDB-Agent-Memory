import json
import re
import os
import time
from deep_translator import GoogleTranslator

FILES = [
  'MemoryPanel/src/panel/infra/logger.ts',
  'MemoryPanel/src/panel/kernel/adapters/fetch-skill-kernel-adapter.ts',
  'MemoryPanel/src/panel/kernel/adapters/http-knowledge-client.ts',
  'MemoryPanel/src/panel/kernel/envelope.ts',
  'MemoryPanel/src/panel/kernel/headers.ts',
  'MemoryPanel/src/panel/kernel/ports/knowledge-client-port.ts',
  'MemoryPanel/src/panel/kernel/ports/skill-kernel-port.ts',
  'MemoryPanel/src/panel/kernel/transport-fetch.ts',
  'MemoryPanel/src/panel/kernel/types.ts',
  'MemoryPanel/src/panel/state/agent-template-store.ts',
  'MemoryPanel/src/panel/state/ingest-progress-store.ts',
  'MemoryPanel/web/.env.example',
  'MemoryPanel/web/.eslintrc.cjs',
  'MemoryPanel/web/README.md',
  'MemoryPanel/web/i18n-migrate.cjs',
  'MemoryPanel/web/scripts/scan-chinese.cjs',
  'MemoryPanel/web/scripts/scan-chinese.mjs',
  'MemoryPanel/web/src/components/LoginGate.tsx',
  'MemoryPanel/web/src/components/MarkdownView.tsx',
  'MemoryPanel/web/src/components/OwnerLabel.tsx',
  'MemoryPanel/web/src/components/ParticleWaveBackground.tsx',
  'MemoryPanel/web/src/components/RouteGuards.tsx',
  'MemoryPanel/web/src/components/SettingsDialog.tsx',
  'MemoryPanel/web/src/components/StatusTag.tsx',
  'MemoryPanel/web/src/components/asset/AllocateAssetDialog.tsx',
  'MemoryPanel/web/src/components/asset/AssetListPanel.tsx',
  'MemoryPanel/web/src/components/asset/AssetMarkdown.tsx',
  'MemoryPanel/web/src/components/asset/AssetPageHeader.tsx',
  'MemoryPanel/web/src/components/asset/AssetSplitLayout.tsx',
  'MemoryPanel/web/src/components/asset/UserBadge.tsx',
  'MemoryPanel/web/src/components/team/AgentEditDialog.tsx',
  'MemoryPanel/web/src/components/team/AgentGrid.tsx',
  'MemoryPanel/web/src/components/team/CreateAgentDialog.tsx',
  'MemoryPanel/web/src/components/team/DefaultAgentTemplateDialog.tsx',
  'MemoryPanel/web/src/components/team/DefaultAgentTemplateSection.tsx',
  'MemoryPanel/web/src/components/team/EditTeamDialog.tsx',
  'MemoryPanel/web/src/components/team/MemberSection.tsx',
  'MemoryPanel/web/src/components/team/TeamHeaderCard.tsx',
  'MemoryPanel/web/src/components/team/TeamManagementPanel.tsx',
  'MemoryPanel/web/src/components/team/shared.tsx',
  'MemoryPanel/web/src/components/team/types.ts',
  'MemoryPanel/web/src/components/team/useAgentAssets.ts',
  'MemoryPanel/web/src/i18n/index.ts',
  'MemoryPanel/web/src/layouts/ConsoleLayout.tsx',
  'MemoryPanel/web/src/layouts/GlobalHeader/LanguageSwitcher.tsx',
  'MemoryPanel/web/src/layouts/GlobalHeader/TeamSwitcher.tsx',
  'MemoryPanel/web/src/layouts/GlobalHeader/index.tsx',
  'MemoryPanel/web/src/layouts/OnboardingGuide.tsx',
  'MemoryPanel/web/src/layouts/TabBar/index.tsx',
  'MemoryPanel/web/src/lib/api/agents.ts',
  'MemoryPanel/web/src/lib/api/assets.ts',
  'MemoryPanel/web/src/lib/api/auth.ts',
  'MemoryPanel/web/src/lib/api/base.ts',
  'MemoryPanel/web/src/lib/api/chat-memory.ts',
  'MemoryPanel/web/src/lib/api/knowledge-api.ts',
  'MemoryPanel/web/src/lib/api/meta-instances.ts',
  'MemoryPanel/web/src/lib/api/skill-api.ts',
  'MemoryPanel/web/src/lib/api/skills.ts',
  'MemoryPanel/web/src/lib/api/tasks.ts',
  'MemoryPanel/web/src/lib/api/teams.ts',
  'MemoryPanel/web/src/lib/api/types.ts',
  'MemoryPanel/web/src/lib/api/users.ts',
  'MemoryPanel/web/src/lib/asset-common.ts',
  'MemoryPanel/web/src/lib/error-message.ts',
  'MemoryPanel/web/src/lib/panelSession.ts',
  'MemoryPanel/web/src/lib/tea-bridge.ts',
  'MemoryPanel/web/src/lib/teamApi.ts',
  'MemoryPanel/web/src/lib/useResizable.ts',
  'MemoryPanel/web/src/pages/ApiKeysPage/components/ApiKeyPanel.tsx',
  'MemoryPanel/web/src/pages/ChatMemoryPage/components/BlockDetail.tsx',
  'MemoryPanel/web/src/pages/ChatMemoryPage/components/ChatMemoryPanel.tsx',
  'MemoryPanel/web/src/pages/ChatMemoryPage/components/ImportBlockDialog.tsx',
  'MemoryPanel/web/src/pages/CodePage/components/CodeSourcesPanel.tsx',
  'MemoryPanel/web/src/pages/CodePage/components/code-detail-view.tsx',
  'MemoryPanel/web/src/pages/CodePage/components/code-ui.tsx',
  'MemoryPanel/web/src/pages/GuidePage/index.tsx',
  'MemoryPanel/web/src/pages/ResourcePage/components/AdminResourceLock.tsx',
  'MemoryPanel/web/src/pages/ResourcePage/components/AssetScopeManager.tsx',
  'MemoryPanel/web/src/pages/ResourcePage/index.tsx',
  'MemoryPanel/web/src/pages/SkillsPage/components/ForkSkillDialog.tsx',
  'MemoryPanel/web/src/pages/SkillsPage/components/ImportSkillDialog.tsx',
  'MemoryPanel/web/src/pages/SkillsPage/components/SkillDetailPane.tsx',
  'MemoryPanel/web/src/pages/SkillsPage/components/SkillsPanel.tsx',
  'MemoryPanel/web/src/pages/WikiPage/components/KnowledgeGraph.tsx',
  'MemoryPanel/web/src/pages/WikiPage/components/WikiSourcesPanel.tsx',
  'MemoryPanel/web/src/pages/WikiPage/components/wiki-detail-components.tsx',
  'MemoryPanel/web/src/pages/WikiPage/components/wiki-detail-view.tsx',
  'MemoryPanel/web/src/pages/WikiPage/components/wiki-ui.tsx',
  'MemoryPanel/web/src/pages/WorkbenchPage/components/BoardView.tsx',
  'MemoryPanel/web/src/pages/WorkbenchPage/components/TaskCreateDialog.tsx',
  'MemoryPanel/web/src/pages/WorkbenchPage/components/TaskDetail.tsx',
  'MemoryPanel/web/src/pages/WorkbenchPage/components/TaskWorkbench.tsx',
  'MemoryPanel/web/src/routes/index.tsx',
  'MemoryPanel/web/src/services/account-store.ts',
  'MemoryPanel/web/src/services/agent-template-store.ts',
  'MemoryPanel/web/src/services/asset-scope-store.ts',
  'MemoryPanel/web/src/services/backendStore.ts',
  'MemoryPanel/web/src/services/index.ts',
  'MemoryPanel/web/src/services/permissions.ts',
  'MemoryPanel/web/src/services/storage-utils.ts',
  'MemoryPanel/web/src/services/use-skill-detail-cache.ts',
  'MemoryPanel/web/src/services/useCurrentRole.ts',
  'MemoryPanel/web/src/services/user-asset-store.ts',
  'MemoryPanel/web/src/services/user-profile-store.ts',
  'MemoryPanel/web/src/stores/auth.ts',
  'MemoryPanel/web/src/stores/backend.ts'
]

CHINESE_REGEX = re.compile(r'[\u4e00-\u9fa5]')

# For specific terminology
TERMS = {
    "腾讯云数据库": "TencentDB",
    "内存核心": "MemoryCore",
    "内存代理": "MemoryProxy",
    "内存知识": "MemoryKnowledge",
    "内存面板": "MemoryPanel",
    "会话绑定": "session binding",
    "钩子缓存": "hook cache"
}

def translate_text(text):
    if not text.strip() or not CHINESE_REGEX.search(text):
        return text
    try:
        translated = GoogleTranslator(source='zh-CN', target='en').translate(text)
        if not translated:
            return text
        for zh, en in TERMS.items():
            translated = translated.replace(zh, en)
        # Also fix some common casing
        translated = translated.replace("Tencent DB", "TencentDB")
        translated = translated.replace("Memory Core", "MemoryCore")
        translated = translated.replace("Memory Proxy", "MemoryProxy")
        translated = translated.replace("Memory Knowledge", "MemoryKnowledge")
        translated = translated.replace("Memory Panel", "MemoryPanel")
        return translated
    except Exception as e:
        print(f"Error translating: {e}")
        return text

def process_file(filepath):
    full_path = os.path.join('C:/Users/yonik/TencentDB-Agent-Memory', filepath)
    if not os.path.exists(full_path):
        return False
        
    if filepath.endswith('_CN.md') or filepath.endswith('.zh-CN.md') or 'i18n/zh-CN.ts' in filepath or 'generated/' in filepath:
        return False

    with open(full_path, 'r', encoding='utf-8') as f:
        content = f.read()

    if not CHINESE_REGEX.search(content):
        return False
        
    is_markdown = filepath.endswith('.md')
    
    lines = content.split('\n')
    new_lines = []
    
    modified = False
    for i, line in enumerate(lines):
        if not CHINESE_REGEX.search(line):
            new_lines.append(line)
            continue
            
        # Ignore t('...') or t("...") in TS/TSX
        if not is_markdown and re.search(r't\([\'"`][^\'"`]*[\u4e00-\u9fa5]+[^\'"`]*[\'"`]\)', line):
            new_lines.append(line)
            continue
            
        if not is_markdown:
            idx = line.find('//')
            if idx != -1:
                prefix = line[:idx+2]
                suffix = line[idx+2:]
                if CHINESE_REGEX.search(suffix):
                    translated = translate_text(suffix)
                    line = prefix + translated
                    modified = True
            else:
                stripped = line.strip()
                if stripped.startswith('/*') or stripped.startswith('*') or stripped.endswith('*/'):
                    match = re.match(r'^(\s*(?:/\*+|\*+)\s*)(.*?)(\s*\*+/)?$', line)
                    if match:
                        prefix = match.group(1)
                        core = match.group(2)
                        suffix = match.group(3) or ''
                        if CHINESE_REGEX.search(core):
                            core_t = translate_text(core)
                            line = prefix + core_t + suffix
                            modified = True
                    else:
                        if CHINESE_REGEX.search(line):
                            line = translate_text(line)
                            modified = True
                else:
                    if re.search(r'(console\.\w+\(|throw new Error\(|new Error\()', line):
                        def replacer(m):
                            return m.group(0)[0] + translate_text(m.group(0)[1:-1]) + m.group(0)[-1]
                        
                        new_line = re.sub(r'[\'"`][^\'"`]*[\u4e00-\u9fa5]+[^\'"`]*[\'"`]', replacer, line)
                        if new_line != line:
                            line = new_line
                            modified = True
        else:
            if CHINESE_REGEX.search(line):
                match = re.match(r'^(\s*#+\s*|\s*-\s*|\s*\d+\.\s*|\s*>\s*)(.*)$', line)
                if match:
                    prefix = match.group(1)
                    core = match.group(2)
                    if CHINESE_REGEX.search(core):
                        line = prefix + translate_text(core)
                        modified = True
                else:
                    line = translate_text(line)
                    modified = True

        new_lines.append(line)

    if modified:
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(new_lines))
        return True
    return False

if __name__ == '__main__':
    modified_files = []
    print("Starting translation...")
    for f in FILES:
        try:
            if process_file(f):
                modified_files.append(f)
                print(f"Translated: {f}")
        except Exception as e:
            print(f"Error on file {f}: {e}")
    
    with open('C:/Users/yonik/TencentDB-Agent-Memory/scratch/modified_files.txt', 'w', encoding='utf-8') as f:
        f.write('\n'.join(modified_files))
    print(f"Done. Modified {len(modified_files)} files.")
