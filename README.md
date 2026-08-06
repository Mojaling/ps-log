# PS Log — 코딩테스트 복습 기록

푼 문제를 기록하고, 틀린 문제는 사용자가 정한 날짜에 다시 보도록 일정을 잡아 주는 개인용 웹 앱입니다. 문제 기록, 문제 사이트 바로가기, 월별 잔디, 최대 6개의 사용자 카테고리와 폴더 트리로 정리하는 개념 노트, 주간 일정표, GitHub 동기화와 복습 메일을 제공합니다.

이 저장소에는 실행 코드만 있습니다. 실제 기록은 각 사용자가 만든 별도의 Private GitHub 저장소의 `data.json`에 저장됩니다.

## 구조

```text
Public 코드 저장소 (이 저장소 또는 Fork)
  ├─ public/            브라우저 앱
  │   ├─ index.html
  │   ├─ app.js
  │   ├─ style.css
  │   ├─ vendor/        로컬 Markdown 파서·HTML 정화기
  │   └─ _headers       보안 헤더 (CSP 등)
  ├─ worker/            복습 메일 · 사용량 조회 Worker
  ├─ team-worker/       팀장이 한 번만 배포하는 중앙 점수 API
  ├─ migrations/team/   중앙 D1 데이터베이스 스키마
  └─ wrangler.jsonc     개인 Cloudflare 배포 설정

Private 데이터 저장소 (사용자별로 별도 생성)
  └─ data.json          문제·개념·일정·이미지 기록
```

- 프런트엔드: 순수 HTML/CSS/JavaScript
- 호스팅 및 cron: Cloudflare Workers + Static Assets
- 데이터 저장: GitHub Contents API
- 브라우저 이미지 캐시: IndexedDB (기존 localStorage 이미지는 첫 실행 때 자동 이전)
- 메일 발송: Resend HTTP API
- 빌드 과정 없음

## 팀 랭킹 — 최대 30명

팀 랭킹은 개인 기록 저장과 분리되어 있습니다. 각 팀원은 자신의 Cloudflare Worker와 Private
`ps-log-data`를 그대로 사용하고, 문제 성공·복습 완료 같은 최소 활동만 팀장이 운영하는 중앙
Worker로 전송합니다. 개인 메모, 풀이 코드, GitHub PAT, `data.json`은 중앙 서버로 보내지 않습니다.

```text
팀원 브라우저 → 각자 PS Log Worker → 팀장 중앙 Worker → 팀장 D1
                 개인 GitHub 동기화       점수 판정·랭킹
```

점수 규칙은 서버에서만 판정합니다.

| 활동 | 점수 |
|---|---:|
| 팀 최초 참가 기본 점수 | 1,000점에서 시작 |
| 처음 성공한 고유 문제 | +3 |
| 서버가 등록한 사용자 지정 예정 복습 완료 | +3 |
| 문제 기록 삭제 | 해당 문제로 받은 문제·복습 점수 전액 회수 |
| 일일 미션 연속 달성 | 1일차 +2, 이후 +4·+6·+8, 5일차부터 +10 |
| 문제 1개 성공 또는 그날까지 밀린 복습을 모두 끝내지 못함 | 하루 한 번 -5, 연속 기록 초기화 |

일일 미션은 **문제 성공 1개 이상 + 그날까지 밀린 복습 전부 완료**입니다. 신규 참가자는 참가
다음 KST 날짜부터 일일 마감 대상이 됩니다. 중앙 Worker는 매일 UTC 15:10(KST 00:10)에 전날을
마감하며, 고유 이벤트 ID와 점수 원장 키로 중복 전송·중복 마감을 막습니다.
Cron이 일시적으로 실패해도 다음 실행에서 최근 7일의 미마감 날짜를 오래된 순서로 복구합니다.
문제를 삭제하면 그 문제의 성공·복습으로 직접 받은 점수는 음수 원장으로 회수됩니다. 이미 확정된
과거 일일 연속 보너스·미달성 벌점은 다른 활동까지 함께 반영된 일일 결과이므로 소급 변경하지 않습니다.

### 팀장이 중앙 서버를 처음 만드는 방법

Cloudflare 계정과 `workers.dev` 주소를 만든 뒤 프로젝트 루트에서 다음 파일을 실행합니다.

```powershell
.\team_settings_kor.bat
```

마법사는 다음 작업을 수행합니다.

1. 팀장 전용 `.team.env` 생성과 Cloudflare OAuth 로그인 확인
2. 중앙 D1 생성 및 `migrations/team` 적용
3. 고정 callback URL로 쓸 GitHub OAuth App 생성 안내
4. 중앙 Worker 배포와 `GITHUB_CLIENT_SECRET`, `ADMIN_KEY`, `SESSION_PEPPER` 등록
5. 팀장 본인용 일회용 초대 코드 발급

GitHub OAuth App 화면에는 마법사가 표시하는 Homepage URL과 Authorization callback URL을
그대로 넣어야 합니다. `.team.env`와 생성된 `wrangler.team.local.jsonc`는 Git에서 제외됩니다.
중앙 구성 템플릿은 `wrangler.team.jsonc`, DB 스키마는 `migrations/team/0001_init.sql`에 있습니다.

팀원을 추가할 때마다 아래 파일을 실행하면 1회용·기본 24시간 초대 코드가 발급됩니다.

```powershell
.\team_invite_kor.bat
```

팀원에게는 출력된 **팀 서버 주소와 초대 코드**만 전달합니다. `ADMIN_KEY`, OAuth secret,
`SESSION_PEPPER`는 절대로 전달하지 않습니다.

### 팀원이 참가하는 방법

각 팀원은 자신의 Fork에서 `settings_kor.bat`을 실행하고 `팀 랭킹 시스템에 참가할까요?`에
`Y`를 선택한 뒤 팀 서버 주소와 일회용 초대 코드를 입력합니다. 개인 Worker 배포가 끝나면
GitHub 로그인 화면이 열리고, 로그인된 GitHub 숫자 ID가 중앙 D1의 팀원 계정이 됩니다.
PAT를 중앙 서버에 입력하는 단계는 없습니다.
공정한 첫 시즌을 위해 참가 전에 저장돼 있던 과거 문제·복습 기록은 소급 점수로 올리지 않고,
GitHub 로그인을 완료한 뒤 새로 발생한 활동부터 계산합니다.

활동은 발생 즉시 보내고 실패한 전송은 브라우저 outbox에서 1분마다 재시도합니다. 랭킹 화면을
보고 있을 때는 1분마다, 다른 화면에서는 5분마다 조회하며 숨겨진 탭에서는 조회를 멈춥니다.
브라우저 새로고침이나 네트워크 끊김 때문에 같은 활동이 다시 가도 서버가 한 번만 계산합니다.

점수·랭킹 데이터와 서버 점수 규칙 변경은 중앙 Worker만 갱신하면 되어 팀원 재배포가 필요 없습니다.
반면 랭킹 UI, 개인 Worker 프록시, 새 활동 이벤트처럼 **개인 코드가 바뀐 경우**에는 팀원이 Fork를
Sync한 뒤 로컬에서 `git pull`하고 `re_settings.bat`으로 다시 배포해야 합니다.

## 0. 시작하기 전에 — Windows 사용자

**PowerShell에서는 `npx` 대신 `npx.cmd`를 쓰세요.** 그냥 `npx`를 실행하면 아래 오류가 납니다.

```text
npx : 이 시스템에서 스크립트를 실행할 수 없으므로 ...\npx.ps1 파일을 로드할 수 없습니다.
```

Windows의 스크립트 실행 정책이 `npx.ps1`을 막아서 나는 오류이며, 이 프로젝트와는 무관합니다.
아래 문서의 모든 `npx ...` 명령을 `npx.cmd ...`로 바꿔 실행하면 그대로 동작합니다.

```powershell
npx.cmd wrangler deploy
```

Git Bash(MINGW64)나 macOS·Linux에서는 `npx` 그대로 쓰면 됩니다. 정책 자체를 바꾸고 싶다면
관리자 PowerShell에서 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`를 실행하면 되지만,
`.cmd`만 붙이면 되는 일이라 굳이 시스템 설정을 건드릴 필요는 없습니다.

## Windows 빠른 시작 — 권장

Windows에서는 아래 한글 마법사를 실행하는 것이 가장 간단합니다.

```powershell
.\settings_kor.bat
```

시작하면 필요한 계정(GitHub·Cloudflare·Resend, 모두 무료)을 먼저 안내하고, 없는 계정은
해당 단계에서 가입 페이지를 열어 줍니다. 미리 만들어 두면 더 빠릅니다.

마법사가 다음 작업을 순서대로 처리합니다.

1. `.env` 확인 또는 `.env.example`에서 자동 생성
2. Git·Node.js·GitHub CLI가 없으면 **winget으로 자동 설치**, npm 패키지와 Wrangler 확인
3. Cloudflare OAuth 로그인, 배포 계정 선택, `workers.dev` 등록 확인
4. GitHub 사용자명·데이터 저장소·브랜치·Worker 이름을 `.env`에 저장
5. `ps-log-data` Private 저장소와 `data.json` 자동 생성
6. 두 GitHub 토큰을 **미리 채워진 발급 화면**으로 안내 (웹용은 발급 확인만, Worker용은 권한 검증)
7. Resend API 키와 수신 이메일 설정
8. `CRON_KEY` 자동 생성
9. 사전 점검 후 `re_settings.bat`으로 최초 배포
10. 배포된 `/__cron?test=1` 주소로 테스트 이메일 자동 요청
11. 이메일 수신 확인 (안 왔으면 **다시 보내기**, 또는 나중에 확인하고 계속 진행)
12. 배포된 웹 설정에 R/W GitHub 토큰을 입력하는 방법 안내

기존 `.env`에 저장소나 이메일이 있으면 실제 값을 터미널에 출력하지 않고 기존 설정을
유지할지만 묻습니다. Cloudflare 사용량 조회 토큰은 핵심 기능에 필요하지 않으므로
`Cloudflare 사용량 조회 기능도 설정할까요? (N 권장)`에서는 보통 `N`을 선택하면 됩니다.

### 6단계 GitHub 토큰 발급이 자동으로 처리하는 것

GitHub는 fine-grained 토큰을 대신 만들어 주는 API를 제공하지 않아 **Generate token 버튼만은
직접 눌러야 합니다.** 나머지는 마법사가 처리합니다.

- 토큰 이름·설명·소유자·사용 기간(366일)·`Contents` 권한이 **미리 채워진 발급 화면**을 엽니다.
  화면에서 직접 고를 것은 데이터 저장소 하나뿐입니다.
- **웹용 R/W 토큰은 마법사가 받지 않습니다.** 터미널·`.env`·클립보드 어디도 거치지 않고,
  발급 여부만 확인합니다. 아직 저장하지 못했다고 답하면 재발급 조건을 안내하고 다시 묻습니다.
  이 토큰은 **비밀번호 관리자 등 안전한 곳에 직접 보관해야 합니다** — GitHub에서는 다시 볼 수 없고,
  12단계에서 웹 설정창에만 붙여넣습니다.
- Worker용 Read-only 토큰만 붙여넣으며, 실제로 `data.json`을 읽을 수 있는지 즉시 검증합니다.
- 웹용 토큰은 검증하지 않으므로 권한이 틀리면 12단계 동기화에서 드러납니다. 마법사가 오류 코드를
  해석해 줍니다 — `401`/`404`는 저장소 선택이 틀린 경우, `403`은 `Contents`가 Read-only인 경우입니다.

영문 마법사가 필요하면 `settings.bat`을 사용할 수 있습니다. 아래 1~5절은 자동 마법사를
사용하지 않을 때 참고하는 수동 설정 방법입니다.

## 1. 코드 Fork

GitHub에서 이 저장소를 Fork합니다. Fork는 코드와 배포 설정만 담으며 개인 기록을 커밋하지 않습니다.

```bash
git clone https://github.com/<내계정>/ps-log.git
cd ps-log
npm install
```

## 2. Private 데이터 저장소 만들기

GitHub에서 `ps-log-data` 같은 이름의 **Private** 저장소를 만듭니다. Windows 한글
마법사를 사용하면 GitHub CLI 브라우저 로그인 후 `data.example.json`을 `data.json`으로
자동 업로드하므로 파일을 직접 만들 필요가 없습니다. 파일이 이미 있으면 기존 데이터를
보호하기 위해 덮어쓰지 않습니다.

수동 설정을 할 때만 `data.example.json`을 복사해 `data.json`으로 만들고 Private 데이터
저장소에 커밋합니다.

```bash
cp data.example.json data.json
```

Private 데이터 저장소의 결과는 다음처럼 단순합니다.

```text
ps-log-data/
└─ data.json
```

> `data.json`을 이 Public 코드 저장소나 Public Fork에 커밋하지 마세요. `.gitignore`에서 차단하고 있습니다.

## 3. GitHub 토큰 만들기

GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens에서 Private 데이터 저장소 하나만 선택합니다.

### 브라우저용 토큰

- Repository access: Only select repositories → `ps-log-data`
- Repository permissions → Contents: **Read and write**

앱이 `data.json`을 읽고 자동 커밋할 때 사용합니다. 토큰은 해당 브라우저의 localStorage에만 저장됩니다.
이 토큰은 설치 마법사나 `.env`에 붙여넣지 않고, 배포가 끝난 뒤 웹페이지의 **설정** 화면에만 입력합니다.

일반적인 노트·폴더·설정 수정은 GitHub 계정과 연결되지 않은 `PS Log Sync Bot` 명의로 동기화합니다.
새 문제를 기록하거나 실패 문제를 성공으로 변경한 경우, 그리고 예정된 복습을 완료한 경우에만
인증된 사용자 명의의 커밋을 만들어 GitHub 기여 그래프에 반영합니다.

### Worker용 토큰

- Repository access: Only select repositories → `ps-log-data`
- Repository permissions → Contents: **Read-only**

자동 복습 메일이 `data.json`을 읽을 때만 사용합니다.

## 4. Cloudflare에 배포

수동 배포를 하는 경우 `wrangler.jsonc`에서 아래 값을 본인의 Private 데이터 저장소에 맞춥니다.
설정 마법사를 사용하면 이 값은 `.env`에서 읽어 배포 명령에 자동 전달됩니다.

```jsonc
"vars": {
  "GITHUB_REPO": "<내계정>/ps-log-data",
  "GITHUB_BRANCH": "master",
  "GITHUB_PATH": "data.json",

  // 사용량 화면에서 Cloudflare 요청 수를 조회할 때 쓰는 Worker 이름.
  // 파일 위쪽의 "name" 값과 같아야 합니다.
  "WORKER_NAME": "ps-log"
}
```

### 4-1. 로그인하고 먼저 배포하기

프로젝트 폴더에서 다음 명령을 실행합니다.

```bash
npx wrangler login
npx wrangler deploy
```

Cloudflare 계정에서 Worker를 처음 사용하는 경우에는 먼저 계정 전용 `workers.dev`
서브도메인을 등록해야 합니다. 한글·영문 설정 마법사는 로그인된 계정의 등록 여부를
자동으로 확인하며, 등록되지 않았다면 정확한 onboarding 페이지를 열어 줍니다. 브라우저에서
서브도메인을 정하고 등록한 뒤 마법사로 돌아오면 등록 상태를 다시 확인하고 배포를 계속합니다.

로컬 PC에서는 `wrangler login` 브라우저 인증을 권장합니다. API 토큰 방식이 꼭 필요하면
Cloudflare의 **Edit Cloudflare Workers** 템플릿으로 토큰을 만들고 다음 권한이 포함됐는지
확인합니다.

- Account: `Workers Scripts Edit`, `Account Settings Read`
- User: `User Details Read`, `Memberships Read`
- Account Resources: 배포에 사용할 본인 계정

마법사에서는 이 값을 `.env`의 `DEPLOY_CF_API_TOKEN`, `DEPLOY_CF_ACCOUNT_ID`에 저장합니다.
`CLOUDFLARE_API_TOKEN`이라는 이름을 `.env`에 직접 쓰면 Worker 사용량 조회 토큰과 Wrangler
배포 인증이 충돌할 수 있으므로 사용하지 않습니다.

배포가 끝나면 Wrangler가 실제 접속 URL을 출력합니다. 예를 들어
`wrangler.jsonc`의 `name`이 `ps-log`라면 다음과 비슷한 주소가 만들어집니다.

```text
https://ps-log.<내-workers.dev-서브도메인>.workers.dev
```

터미널에 출력된 `https://...workers.dev` 주소가 실제 서비스 주소입니다. 이후 같은
Worker 이름으로 다시 배포하면 같은 URL의 코드가 업데이트됩니다.

### 4-2. 메일 발송에 필요한 값 준비하기

| 값 | 용도 | 예시 |
|---|---|---|
| `GITHUB_TOKEN` | Private 데이터 저장소의 `data.json` 읽기 | `github_pat_...` |
| `RESEND_API_KEY` | Resend를 통한 이메일 발송 | `re_...` |
| `MAIL_TO` | 복습 메일을 받을 주소 | `본인메일` |
| `CRON_KEY` | 수동 발송·사용량 조회를 보호하는 비밀키 | 임의의 64자리 문자열 |
| `MAIL_FROM` | 발신 주소. 개인 도메인을 쓸 때만 설정 | `PS Log <review@example.com>` |
| `CF_API_TOKEN` | (선택) 사용량 화면의 Cloudflare 요청 수 조회 (Account Analytics: Read) | `v1.0-...` |
| `CF_ACCOUNT_ID` | (선택) 위 조회에 쓰는 Cloudflare 계정 ID | `a1b2c3...` |

`CF_API_TOKEN`·`CF_ACCOUNT_ID`는 설정창의 **사용량** 화면에서 Cloudflare Worker 요청 수를
보고 싶을 때만 넣습니다. 넣지 않으면 그 항목만 "미설정"으로 표시되고 나머지는 정상 동작합니다.

#### RESEND_API_KEY 발급 방법

1. [Resend](https://resend.com/)에 가입하고 로그인합니다.
2. [Resend API Keys](https://resend.com/api-keys)에서 **ADD API KEY** 또는 **Create API Key**를 바로 누릅니다.
3. 이름을 입력하고 권한은 메일 발송만 가능한 **Sending access**를 선택합니다.
4. 생성 직후 한 번만 표시되는 `re_...` 값을 복사해 안전하게 보관합니다.

개인 도메인을 아직 Resend에 등록하지 않았다면 기본 발신 주소
`PS Log <onboarding@resend.dev>`를 사용할 수 있습니다. 이 테스트용 도메인은
Resend 계정에 등록된 본인 이메일로만 발송할 수 있습니다. 다른 사람에게도 보내려면
[Resend에서 개인 도메인을 인증](https://resend.com/docs/dashboard/domains/introduction)한 뒤
`MAIL_FROM`을 그 도메인의 주소로 설정하세요.

#### CRON_KEY 생성 방법

`CRON_KEY`는 Cloudflare나 별도 사이트에서 발급받는 키가 아닙니다. `/__cron` 수동
실행 주소를 다른 사람이 호출하지 못하도록 본인이 만드는 긴 임의 문자열입니다.
외부 키 생성 사이트에 비밀값을 맡기지 말고 터미널에서 다음처럼 생성하는 것을
권장합니다.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

예시 출력은 다음과 같습니다. 실제로는 위 명령을 실행해서 새로 나온 값을 사용하세요.

```text
4d7b1c8e9f2a6d3c0b5e7a1f8c4d9e2b6a0c3f7d1e5b8a4c9d2f6e0b3a7c1d5e
```

### 4-3. Worker secret 등록하기

배포가 한 번 완료된 뒤 다음 명령을 하나씩 실행합니다. 명령 실행 후 나타나는 입력창에
각 값을 붙여넣습니다. 값을 명령문 뒤에 직접 적거나 Git에 커밋하지 마세요.

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_TO
npx wrangler secret put CRON_KEY
npx wrangler secret put MAIL_FROM
# 사용량 화면에서 Cloudflare 요청 수까지 보고 싶을 때만
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
```

입력 예시는 다음과 같습니다.

```text
GITHUB_TOKEN    → github_pat_xxxxxxxxxxxxxxxx
RESEND_API_KEY  → re_xxxxxxxxxxxxxxxxxxxxxxxx
MAIL_TO         → 본인메일
CRON_KEY        → 위 명령으로 생성한 64자리 문자열
MAIL_FROM       → PS Log <review@example.com>
```

`MAIL_FROM`은 선택 사항입니다. 개인 도메인을 인증하지 않았다면 이 명령은 건너뛰세요.
생략 시 `PS Log <onboarding@resend.dev>`를 사용합니다.

`latest version of your Worker isn't currently deployed` 오류가 나오면 아직 최신 Worker가
배포되지 않은 상태입니다. 먼저 `npx wrangler deploy`를 실행한 다음 secret 등록 명령을
다시 실행하세요.

## 5. 앱에서 데이터 저장소 연결

배포된 사이트에서 **설정**을 열고 다음 값을 입력합니다.

| 항목 | 값 |
|---|---|
| 저장소 | `<내계정>/ps-log-data` |
| 액세스 토큰 | 브라우저용 Read and write 토큰 |
| 브랜치 | `master` |
| 파일 경로 | `data.json` |
| 받는 주소 | 복습 메일을 받을 주소 |

연결 테스트 후 저장합니다. 다른 기기에서도 각각 한 번씩 설정해야 합니다.

### Windows 최초 설정과 재배포

포크한 뒤 처음 설정할 때는 프로젝트 루트의 한글판 `settings_kor.bat`을 실행합니다. 설정 마법사가
`.env` 생성, 필수 프로그램 검사, 비공개 데이터 저장소와 GitHub 토큰 안내, Resend 및
Cloudflare 연결, `CRON_KEY` 생성, 최초 배포까지 순서대로 진행합니다.

```powershell
.\settings_kor.bat
```

- `.env`는 Git에서 제외되며 커밋하지 않습니다.
- 기본 데이터 저장소 이름은 `ps-log-data`이며 마법사에서 소유자·저장소·브랜치를 입력합니다.
- 비공개 저장소만 만들면 GitHub CLI의 브라우저 로그인으로 `data.example.json`을 `data.json`으로 자동 업로드합니다.
- 브라우저용 R/W 토큰은 설치 마법사나 `.env`에 붙여넣지 않고, 배포 후 웹 설정 화면에만 입력합니다.
- 브라우저용 Read/Write 토큰과 Worker용 Read-only 토큰은 **둘 다 비공개 데이터 저장소**만 대상으로 발급합니다.
- 브라우저용 토큰은 웹 설정 화면에, Worker용 토큰은 마법사를 통해 `.env`의 `GITHUB_TOKEN`에 저장합니다.
- `GITHUB_TOKEN`, `RESEND_API_KEY`, `MAIL_TO`, `CRON_KEY`는 필수입니다.
- `MAIL_FROM`, `WORKER_CF_API_TOKEN`, `WORKER_CF_ACCOUNT_ID`, `DEPLOY_CF_API_TOKEN`, `DEPLOY_CF_ACCOUNT_ID`는 선택 항목입니다.
- `npm install`과 `wrangler login`이 필요하면 마법사가 실행 여부를 묻습니다.
- 기존 영문 마법사가 필요하면 `settings.bat`을 사용할 수 있습니다.
- 기존 `.env`의 저장소·이메일·계정 정보는 설정 화면에 실제 값으로 출력하지 않습니다.

최초 설정 이후 코드 변경을 다시 배포할 때는 `re_settings.bat`을 실행합니다.

```powershell
.\re_settings.bat
```

재배포할 때마다 화면 오른쪽 아래 웹 버전이 `1.0.0 → 1.0.1 → … → 1.0.9 → 1.1.0` 순서로
증가합니다. 최초 설정 마법사에서 수행하는 첫 배포는 `1.0.0`을 유지합니다.

개인별 마지막 배포 버전은 Git에서 제외되는 `.deploy-version`에만 저장합니다. 배포할 때
`public/version.js`를 잠시 증가시켜 업로드한 뒤 원본으로 되돌리므로 작업 트리가 더러워지거나
Fork 동기화에서 버전 파일 충돌이 생기지 않습니다. `version.js`에 해결되지 않은 Git 충돌 표시가
남아 있으면 잘못된 JavaScript를 올리지 않도록 배포 전에 중단합니다. 버전을 올리지 않고
배포하려면 `.\re_settings.bat --no-bump`를 사용합니다.

## 6. 메일 테스트

배포할 때 출력된 실제 Worker URL과 본인의 `CRON_KEY`를 사용합니다. 키는
`Authorization` 헤더로 보내며, 메일 발송 엔드포인트는 `POST` 요청만 받습니다.

```bash
curl -X POST -H "Authorization: Bearer <CRON_KEY>" \
  "https://ps-log.<내-workers.dev-서브도메인>.workers.dev/__cron?test=1"
```

`test=1`을 붙이면 복습할 문제가 없어도 한 통 보내 설정을 확인할 수 있습니다.

응답으로 돌아오는 메시지는 다음과 같습니다.

| 응답 | 뜻 |
|---|---|
| `테스트 메일을 발송했습니다.` | 정상 |
| `Forbidden` | `CRON_KEY`가 틀렸거나 시크릿이 등록되지 않음 |
| `Not found` | 주소 오타 (`/__cron`, `/__usage`만 받습니다) |
| `GITHUB_TOKEN 시크릿이 없습니다` | 4-3에서 시크릿 등록을 건너뜀 |
| `GitHub 401` | Worker용 토큰이 틀렸거나 만료됨 |
| `GitHub 404` | 저장소·브랜치·경로 또는 토큰 접근 범위 확인 |
| `Resend 403` | 무료 계정의 수신 주소 제한 (가입에 쓴 주소로만 발송 가능) |
| `Resend 401` | `RESEND_API_KEY`가 틀렸거나 만료됨 |
| `받는 주소가 없습니다 ...` | `MAIL_TO` 시크릿 또는 `data.json`의 `settings.email` 필요 |

자세한 원인(외부 API가 돌려준 응답 본문)은 보안상 HTTP 응답에 싣지 않고 Worker 로그에만
남깁니다. `npx wrangler tail`로 실시간 로그를 보거나 Cloudflare 대시보드의 Workers Logs에서
확인하세요.

cron은 기본적으로 매일 UTC 23:00, 한국 시각 오전 8시에 실행됩니다.

## 7. 사용량 확인

설정창 아래쪽 **사용량**에서 지금 쓰고 있는 외부 서비스의 잔여량을 볼 수 있습니다.

| 항목 | 내용 | 필요한 값 |
|---|---|---|
| 로컬 사진 | 사진 장수·원본 합계·`data.json` 내부 Base64 크기 | 없음 |
| `data.json` | 다음 동기화 예상 크기·GitHub 전송 요청 예상 크기 | 없음 |
| GitHub 저장 파일 | 현재 원격 `data.json`의 실제 크기 | 브라우저용 토큰 |
| 브라우저 저장공간 | 이 사이트의 IndexedDB·캐시 사용량과 브라우저 할당량 추정치 | 없음 |
| 깃허브 API | 시간당 잔여 요청 수와 초기화 시각 | 위에서 넣은 브라우저용 토큰 |
| Resend | [대시보드](https://resend.com/emails) 링크 (아래 설명) | 없음 |
| Cloudflare | 최근 24시간 Worker 요청 수 (무료 10만/일 기준) | `CF_API_TOKEN` · `CF_ACCOUNT_ID` |

깃허브 항목은 브라우저에서 바로 조회합니다. Cloudflare는 API 토큰을 브라우저로
내려보내지 않기 위해 Worker의 `/__usage`를 거쳐 **숫자만** 받아 옵니다. 이 주소는
`CRON_KEY`로 보호되므로, 설정창의 **관리 키** 칸에 `CRON_KEY`를 넣어야 이 항목이
보입니다. 비워 두면 "관리 키 미입력"으로 남고 나머지는 정상 동작합니다.

관리 키도 깃허브 토큰과 마찬가지로 **그 브라우저의 localStorage에만** 저장됩니다.
공용 PC에서는 넣지 마세요.

로컬 사진·`data.json` 예상 크기는 설정창을 여는 즉시 계산됩니다. `data.json`은 20MB를 실사용
권장선으로 표시하고 80%부터 경고합니다. 이 값은 GitHub의 하드 제한이 아니라, 모든 사진을 한 파일로
직렬화하고 다시 Base64로 전송하는 현재 동기화 방식에서 브라우저 메모리와 전송 시간을 고려한 기준입니다.

### Resend는 왜 숫자가 아니라 링크인가

3단계에서 만든 `RESEND_API_KEY`는 **Sending access** 권한이라 메일 발송만 할 수 있습니다.
발송량 조회는 발송 목록을 읽는 동작이라 Resend가 `401 restricted_api_key`로 거부합니다.
이걸 뚫으려면 키를 **Full access**로 바꿔야 하는데, 그러면 도메인과 API 키까지 만들고
지울 수 있는 키가 Worker에 놓입니다. 숫자 한 줄을 앱에서 보려고 감수할 거래가 아니라서
앱은 대시보드 링크만 띄웁니다.

### Cloudflare 항목 설정

이 기능은 선택 사항이며 설치 마법사에서도 **N을 권장**합니다. 설정하지 않아도 GitHub
동기화, 배포, 오전 8시 메일은 모두 정상 작동합니다.

**1. 계정 ID 확인**

```bash
npx wrangler whoami
```

출력에서 Account ID를 복사합니다.

**2. API 토큰 생성**

Cloudflare 대시보드 → 우측 상단 프로필 → **API Tokens** → **Create Token** →
맨 아래 **Create Custom Token**에서 다음과 같이 만듭니다.

| 항목 | 값 |
|---|---|
| Token name | 아무 이름 (예: `PS-LOG`) |
| Permissions | `Account` · **Account Analytics** · **Read** |
| Account Resources | `Include` · 본인 계정 |
| Token expiration | `1 year` 등 넉넉한 기간 |
| Client IP address filtering | **비워 둘 것** |

만들고 나면 정책 줄이 이렇게 보여야 합니다.

```text
Entire <내계정>'s Account account
Account Analytics  Read
```

세 가지를 주의하세요.

- **`Account API Tokens` 권한을 고르지 마세요.** 상단 템플릿 목록의 `Create Account Tokens`를
  누르면 이 권한이 자동으로 채워지는데, 이건 *새 API 토큰을 발급할 수 있는* 권한입니다.
  유출되면 원하는 권한의 토큰을 얼마든지 찍어낼 수 있어 사실상 계정 전체를 넘겨주는 것과
  같습니다. 필요한 것은 `Account Analytics` **Read** 하나뿐입니다.
- **Client IP address filtering은 반드시 비워 두세요.** 이 토큰을 쓰는 주체는 내 PC가 아니라
  **Cloudflare Worker**이고, Worker의 출발지 IP는 고정되지 않습니다. IP를 넣으면 사용량
  조회가 항상 실패합니다.
- **Token expiration의 시작일과 종료일을 같은 날로 두지 마세요.** 커스텀 날짜 범위가
  `12/31/26 - 12/31/26`처럼 하루짜리면 그날 하루만 유효합니다. `1 year` 버튼을 쓰는 편이
  간단합니다.

**3. 시크릿 등록**

```bash
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
```

한글 설치 마법사를 사용할 때는 `.env`에 `WORKER_CF_API_TOKEN`과
`WORKER_CF_ACCOUNT_ID`라는 이름으로 저장합니다. 배포 스크립트가 Worker 시크릿
`CF_API_TOKEN`, `CF_ACCOUNT_ID`로 변환해서 등록하므로 두 용도의 토큰이 섞이지 않습니다.

시크릿은 **재배포 없이 바로 반영**됩니다. 등록 후 설정창에서 "사용량 확인"을 다시 누르면
최근 24시간 요청 수가 나옵니다. 읽기 전용 권한이라 이 토큰이 새어도 설정을 바꾸지는
못하며, 만료되면 사용량 화면의 Cloudflare 줄만 "조회 실패"로 바뀌고 복습 메일·동기화 같은
실제 기능은 영향받지 않습니다.

## 로컬 실행은 선택 사항

배포가 끝났다면 평소에는 터미널 명령이 필요하지 않습니다. `npx wrangler deploy`가
출력한 `https://...workers.dev` URL에 접속하면 됩니다. 아래 명령은 배포 전에 내
컴퓨터에서 변경 사항을 확인할 때만 사용합니다.

### Worker 기능까지 로컬에서 확인하기

로컬에서 실제 데이터 연결이나 메일 발송까지 시험하려면 프로젝트 루트에 `.dev.vars`
파일을 만들고 로컬 테스트용 secret을 넣습니다. 이 파일은 Git에 커밋하지 마세요.

```dotenv
GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxx
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
MAIL_TO=본인메일
CRON_KEY=로컬_테스트용_임의_문자열
# 개인 도메인을 Resend에 인증한 경우에만 사용
MAIL_FROM="PS Log <review@example.com>"
# 사용량 화면의 Cloudflare 항목을 쓸 때만
CF_API_TOKEN=v1.0-xxxxxxxx
CF_ACCOUNT_ID=xxxxxxxxxxxxxxxx
```

그다음 실행합니다.

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:8787`을 엽니다. 이 방식은 정적 화면뿐 아니라
`worker/index.js`, `/__cron`, 메일 발송 같은 Worker 기능도 로컬에서 실행합니다.

로컬 테스트 메일 호출 예시:

```bash
curl -X POST -H "Authorization: Bearer 로컬_테스트용_임의_문자열" \
  "http://localhost:8787/__cron?test=1"
```

### 화면만 빠르게 확인하기

다음 명령은 `public` 폴더의 HTML, CSS, JavaScript만 단순 웹 서버로 보여 줍니다.

```bash
python -m http.server 8000 --directory public
```

브라우저에서 `http://localhost:8000`을 엽니다. 이 방식은 화면 확인용이므로
`worker/index.js`, 예약 실행, `/__cron` 메일 발송 기능은 실행되지 않습니다.

> 이 단순 서버는 `public/_headers`를 적용하지 않으므로 CSP 없이 뜹니다. 보안 헤더까지
> 실제와 같게 확인하려면 `npm run dev`(Wrangler)나 실제 배포본을 쓰세요.

## 데이터와 보안

- Public 저장소에는 개인 `data.json`을 두지 않습니다.
- 브라우저용 토큰은 Private 데이터 저장소 하나에만 Read and write 권한을 줍니다.
- Worker용 토큰은 같은 저장소에 Read-only 권한만 줍니다.
- `.dev.vars`, 토큰, Resend 키는 Git에 커밋하지 않습니다.
- Public 저장소를 만들 때 개인 데이터가 있던 저장소의 Git 기록을 복사하지 마세요.
- 기록을 바꾸면 앱이 약 4초 후 Private 데이터 저장소에 자동 커밋합니다.
- `CRON_KEY`는 URL이 아니라 `Authorization: Bearer` 헤더로 보냅니다.

브라우저용 토큰과 관리 키는 그 브라우저의 localStorage에 들어 있습니다. 즉 이 사이트에서
스크립트가 한 번이라도 실행되면 토큰까지 함께 넘어갑니다. 그래서 앱은 다음을 지킵니다.

- 문제 링크와 개념 노트의 링크는 `http`·`https`·`mailto`만 `<a>`로 만듭니다.
  (`javascript:` 같은 주소는 링크를 걸지 않고 표시만 남깁니다.)
- 노트의 사진은 `data:image/...`와 `http(s)` 주소만 렌더링합니다.
- Markdown은 로컬에 포함한 `marked`로 변환한 뒤 DOMPurify로 정화합니다. 원시 HTML의
  스크립트·폼·스타일과 위험한 속성은 제거됩니다.
- `data.json`에서 온 일반 값은 화면에 넣기 전에 모두 이스케이프합니다 (id 같은 속성값 포함).
- `public/_headers`의 CSP가 외부 스크립트 실행과 깃허브 API 외의 외부 통신을 막습니다.
- 복습 메일 본문도 같은 규칙으로 이스케이프해서 만듭니다.

### 알고 쓰는 남은 위험

- **`/__cron`에 레이트 리밋이 없습니다.** 64자리 임의 키라 현실적 위험은 낮지만, 키를
  맞히면 메일 발송이 트리거됩니다. 걱정되면 Cloudflare Rate Limiting 규칙을 하나 걸어 두세요.
- **관리 키를 넣으면 `CRON_KEY`도 브라우저에 저장됩니다.** 공용 PC에서는 관리 키 칸을
  비워 두세요. 사용량 화면의 Cloudflare 줄만 안 보이고 나머지는 정상 동작합니다.

## 코드를 바꿨다면 다시 배포하세요

이 저장소를 Fork해서 쓰고 있다면 꼭 기억해 주세요. **`public/`이나 `worker/`의 코드를
고치거나, 원본 저장소의 변경 사항을 받아 왔다면 그때마다 다시 배포해야 실제 사이트에
반영됩니다.** Cloudflare는 배포된 시점의 파일을 서빙하므로, Git에 커밋·푸시하는 것만으로는
사이트가 바뀌지 않습니다.

```powershell
git pull                 # 원본 변경 사항을 받아 왔다면
.\re_settings.bat        # Windows: 로컬 버전 증가 + 배포 + 시크릿 갱신
```

macOS·Linux 또는 수동 배포에서는 `npx wrangler deploy`를 사용할 수 있습니다. Windows의
`re_settings.bat`은 화면 오른쪽 아래 웹 버전을 `1.0.0 → 1.0.1 → … → 1.1.0` 순서로
증가시킨 뒤 로컬 코드를 배포합니다. 마지막 개인 배포 버전은 Git에서 제외된 `.deploy-version`에
기록하므로 `public/version.js`를 커밋하거나 푸시하지 않습니다.

- 브라우저 앱(`public/`)과 Worker(`worker/`)는 한 번의 `wrangler deploy`로 함께 올라갑니다.
- `wrangler.jsonc`의 `vars`를 고친 경우에도 재배포해야 적용됩니다.
- 시크릿(`npx wrangler secret put ...`)은 재배포 없이 바로 반영됩니다.
- 배포한 뒤에도 화면이 그대로면 브라우저 강력 새로고침(Ctrl/Cmd + Shift + R)을 해 보세요.
- 설정창의 **사용량**에서 `/__usage 를 찾을 수 없습니다 (404)`가 뜨면 재배포가 안 된 상태입니다.

## 주요 기능

- 문제 번호·제목·사이트·난이도·결과 기록
- 실패 문제의 복습 날짜를 1~365일 범위에서 최대 5회까지 설정
- 월별 문제/복습 잔디
- 이름을 바꿀 수 있는 최대 6개 상위 카테고리, 태그 선택 필터, 중첩 폴더 트리와 Markdown 노트·이미지
- 개념 노트·폴더 드래그 앤 드롭 이동과 현재 노트의 독립형 Markdown 내보내기
- 이미지 원본은 브라우저의 IndexedDB에 저장하고 GitHub 동기화 때 `data.json`에 다시 포함
- 선택 영역 굵게(Ctrl+B)·기울임(Ctrl+I)·밑줄(Ctrl+U)·형광펜(Ctrl+Space)·글자색(Ctrl+H) 토글
- 긴 HTML 태그 대신 짧은 서식 표기와 설정 가능한 Tab 들여쓰기(기본 4칸, Shift+Tab 내어쓰기)
- 줄 복사(Ctrl+Alt+↓)·줄 삭제(Ctrl+D), 3×3 표 템플릿 넣기, 강제 빈 줄(`;;;`)
- 타이핑과 서식 편집을 함께 되돌리는 Ctrl+Z (최근 10회)
- Java·C++·Python Markdown 코드 블록의 로컬 문법 강조
- 제목·강조·중첩 목록·체크박스·링크·이미지·코드·표·인용문·수평선·줄바꿈·안전한 원시 HTML 등 GFM 문법
- 자주 푸는 문제 사이트 바로가기 추가·삭제
- 파랑·노랑·보라로 구분하고 완료 시 초록색으로 표시하는 주간 일정표
- Todo를 다른 날짜로 드래그해 이동하고, 기본 Todo를 등록해 오늘 일정에 한 번에 추가
- 문제·개념·일정표·팀 랭킹 탭을 바꿔도 개념 화면과 같은 너비로 유지
- 한국 시간 오전 8시 기준으로 지난 날짜의 미완료 Todo 잠금·빨간색 표시
- 여러 기기 간 GitHub 동기화와 충돌 처리
- Resend를 이용한 자동 복습 메일
- 깃허브 API·Cloudflare 사용량 확인 (Resend는 대시보드 링크)

Markdown 입력 문법은 [HEROPY의 Markdown 사용법 정리](https://www.heropy.dev/p/B74sNE)에
소개된 범위를 기준으로 하며, GitHub Flavored Markdown 호환 파서로 렌더링합니다.

### 개념 노트 편집 단축키

| 동작 | 단축키 / 버튼 |
|---|---|
| 굵게 · 기울임 · 밑줄 | Ctrl+B · Ctrl+I · Ctrl+U |
| 형광펜 · 글자색 | Ctrl+Space · Ctrl+H |
| 위첨자 · 아래첨자 | Ctrl+Shift+. · Ctrl+Shift+, |
| 들여쓰기 · 내어쓰기 | Tab · Shift+Tab |
| **지금 줄을 아래에 복사** | **Ctrl+Alt+↓** |
| **지금 줄 삭제** | **Ctrl+D** |
| **3×3 표 넣기** | 서식 바의 **표** 버튼 |
| **강제 빈 줄** | 서식 바의 **빈 줄** 버튼 또는 `;;;` 직접 입력 |
| **되돌리기 (최근 10회)** | **Ctrl+Z** |

Markdown은 빈 줄을 아무리 넣어도 문단 사이 간격이 하나로 합쳐집니다. 문단을 더 띄우고 싶으면
`;;;` 만 있는 줄을 넣으세요. 그 줄이 빈 줄 하나로 렌더링되며, 여러 번 넣으면 그만큼 벌어집니다.

```text
첫 문단
;;;
;;;
두 칸 띄운 문단
```

코드 블록(``` ```) 안의 `;;;` 는 코드 그대로 남습니다.

되돌리기는 타이핑뿐 아니라 **서식 적용·표 넣기·줄 복사/삭제·사진 넣기까지** 함께 되돌립니다.
브라우저가 textarea에 붙여 주는 기본 되돌리기는 앱이 내용을 바꾸는 순간 기록이 사라지기 때문에,
앱이 직접 최근 10회를 기록합니다. 연속으로 타이핑하는 동안은 한 덩어리로 묶여 글자마다 칸을
쓰지 않으며, 다른 노트를 열면 기록이 초기화됩니다.

## 자주 막히는 곳

| 증상 | 원인과 해결 |
|---|---|
| `npx : 이 시스템에서 스크립트를 실행할 수 없으므로...` | PowerShell 실행 정책. `npx` 대신 `npx.cmd`를 쓰세요 ([0번 항목](#0-시작하기-전에--windows-사용자)) |
| 코드를 고쳤는데 사이트가 그대로 | `npx wrangler deploy` 후 강력 새로고침(Ctrl/Cmd + Shift + R) |
| 사용량에서 `/__usage 를 찾을 수 없습니다 (404)` | 재배포가 안 된 상태입니다 |
| 사용량에서 `관리 키가 맞지 않습니다 (403)` | 설정창의 관리 키와 `CRON_KEY` 시크릿이 다릅니다 |
| Cloudflare 줄이 계속 `미설정` | `CF_API_TOKEN`·`CF_ACCOUNT_ID` 시크릿 등록 필요 |
| Cloudflare 줄이 `조회 실패` | 토큰 권한이 `Account Analytics: Read`인지, IP 필터가 비었는지, 만료되지 않았는지 확인 |
| Resend 줄에 숫자가 안 나옴 | 정상입니다. [설계상 대시보드 링크](#resend는-왜-숫자가-아니라-링크인가)로 안내합니다 |
| `latest version of your Worker isn't currently deployed` | 시크릿 등록 전에 `npx wrangler deploy`를 먼저 하세요 |
| `register a workers.dev subdomain before publishing` | `settings_kor.bat`을 다시 실행해 8단계에서 계정 서브도메인을 등록하세요 |
| 동기화가 `401`/`404` | 설정창의 저장소·브랜치·경로와 브라우저용 토큰 범위를 확인하세요 |
