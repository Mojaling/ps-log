# PS Log — 코딩테스트 복습 기록

푼 문제를 기록하고, 틀린 문제는 3·7·21일 뒤에 다시 보도록 일정을 잡아 주는 개인용 웹 앱입니다. 문제 기록, 월별 잔디, C++/Java/Python 개념 노트, 주간 일정표, GitHub 동기화와 복습 메일을 제공합니다.

이 저장소에는 실행 코드만 있습니다. 실제 기록은 각 사용자가 만든 별도의 Private GitHub 저장소의 `data.json`에 저장됩니다.

## 구조

```text
Public 코드 저장소 (이 저장소 또는 Fork)
  ├─ public/            브라우저 앱
  ├─ worker/            복습 메일 Worker
  └─ wrangler.jsonc     Cloudflare 배포 설정

Private 데이터 저장소 (사용자별로 별도 생성)
  └─ data.json          문제·개념·일정·이미지 기록
```

- 프런트엔드: 순수 HTML/CSS/JavaScript
- 호스팅 및 cron: Cloudflare Workers + Static Assets
- 데이터 저장: GitHub Contents API
- 메일 발송: Resend HTTP API
- 빌드 과정 없음

## 1. 코드 Fork

GitHub에서 이 저장소를 Fork합니다. Fork는 코드와 배포 설정만 담으며 개인 기록을 커밋하지 않습니다.

```bash
git clone https://github.com/<내계정>/ps-log.git
cd ps-log
npm install
```

## 2. Private 데이터 저장소 만들기

GitHub에서 `ps-log-data` 같은 이름의 **Private** 저장소를 만들고 기본 브랜치를 `master`로 설정합니다. `data.example.json`을 복사해 `data.json`으로 만들고 데이터 저장소에만 커밋합니다.

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

### Worker용 토큰

- Repository access: Only select repositories → `ps-log-data`
- Repository permissions → Contents: **Read-only**

자동 복습 메일이 `data.json`을 읽을 때만 사용합니다.

## 4. Cloudflare에 배포

`wrangler.jsonc`에서 아래 값을 본인의 Private 데이터 저장소에 맞춥니다.

```jsonc
"vars": {
  "GITHUB_REPO": "<내계정>/ps-log-data",
  "GITHUB_BRANCH": "master",
  "GITHUB_PATH": "data.json"
}
```

### 4-1. 로그인하고 먼저 배포하기

프로젝트 폴더에서 다음 명령을 실행합니다.

```bash
npx wrangler login
npx wrangler deploy
```

배포가 끝나면 Wrangler가 실제 접속 URL을 출력합니다. 예를 들어
`wrangler.jsonc`의 `name`이 `ps-log`라면 다음과 비슷한 주소가 만들어집니다.

```text
https://ps-log.<내-workers.dev-서브도메인>.workers.dev
```

터미널에 출력된 `https://...workers.dev` 주소가 실제 서비스 주소입니다. 이후 같은
Worker 이름으로 다시 배포하면 같은 URL의 코드가 업데이트됩니다.

> Windows PowerShell에서 `npx.ps1` 실행 정책 오류가 발생하면 아래 명령들의
> `npx`를 `npx.cmd`로 바꿔 실행하세요. 예: `npx.cmd wrangler deploy`

### 4-2. 메일 발송에 필요한 값 준비하기

| 값 | 용도 | 예시 |
|---|---|---|
| `GITHUB_TOKEN` | Private 데이터 저장소의 `data.json` 읽기 | `github_pat_...` |
| `RESEND_API_KEY` | Resend를 통한 이메일 발송 | `re_...` |
| `MAIL_TO` | 복습 메일을 받을 주소 | `me@example.com` |
| `CRON_KEY` | 수동 발송·사용량 조회를 보호하는 비밀키 | 임의의 64자리 문자열 |
| `MAIL_FROM` | 발신 주소. 개인 도메인을 쓸 때만 설정 | `PS Log <review@example.com>` |
| `CF_API_TOKEN` | (선택) 사용량 화면의 Cloudflare 요청 수 조회 (Account Analytics: Read) | `v1.0-...` |
| `CF_ACCOUNT_ID` | (선택) 위 조회에 쓰는 Cloudflare 계정 ID | `a1b2c3...` |

`CF_API_TOKEN`·`CF_ACCOUNT_ID`는 설정창의 **사용량** 화면에서 Cloudflare Worker 요청 수를
보고 싶을 때만 넣습니다. 넣지 않으면 그 항목만 "미설정"으로 표시되고 나머지는 정상 동작합니다.

#### RESEND_API_KEY 발급 방법

1. [Resend](https://resend.com/)에 가입하고 로그인합니다.
2. [Resend API Keys](https://resend.com/api-keys)에서 **Create API Key**를 누릅니다.
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
MAIL_TO         → me@example.com
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

## 6. 메일 테스트

배포할 때 출력된 실제 Worker URL과 본인의 `CRON_KEY`를 사용합니다. 키는 **헤더로**
보내세요. 쿼리스트링(`?key=`)에 담으면 요청 URL이 Cloudflare Workers 로그와 브라우저
방문 기록에 그대로 남습니다.

```bash
curl -H "Authorization: Bearer <CRON_KEY>" \
  "https://ps-log.<내-workers.dev-서브도메인>.workers.dev/__cron?test=1"
```

`test=1`을 붙이면 복습할 문제가 없어도 한 통 보내 설정을 확인할 수 있습니다.
예전 방식인 `?key=<CRON_KEY>`도 계속 동작하지만 위 방법을 권장합니다.

- `테스트 메일을 발송했습니다.`: 정상
- `Forbidden`: `CRON_KEY` 확인
- `GitHub 404`: 저장소·브랜치·토큰 접근 범위 확인
- `Resend 403`: 무료 계정의 수신 주소 제한 확인

cron은 기본적으로 매일 UTC 23:00, 한국 시각 오전 8시에 실행됩니다.

## 7. 사용량 확인

설정창 아래쪽 **사용량**에서 지금 쓰고 있는 외부 서비스의 잔여량을 볼 수 있습니다.

| 항목 | 내용 | 필요한 값 |
|---|---|---|
| 깃허브 API | 시간당 잔여 요청 수와 초기화 시각 | 위에서 넣은 브라우저용 토큰 |
| Resend | [대시보드](https://resend.com/emails) 링크 (아래 설명) | 없음 |
| Cloudflare | 최근 24시간 Worker 요청 수 (무료 10만/일 기준) | `CF_API_TOKEN` · `CF_ACCOUNT_ID` |

깃허브 항목은 브라우저에서 바로 조회합니다. Cloudflare는 API 토큰을 브라우저로
내려보내지 않기 위해 Worker의 `/__usage`를 거쳐 **숫자만** 받아 옵니다. 이 주소는
`CRON_KEY`로 보호되므로, 설정창의 **관리 키** 칸에 `CRON_KEY`를 넣어야 이 항목이
보입니다. 비워 두면 "관리 키 미입력"으로 남고 나머지는 정상 동작합니다.

관리 키도 깃허브 토큰과 마찬가지로 **그 브라우저의 localStorage에만** 저장됩니다.
공용 PC에서는 넣지 마세요.

### Resend는 왜 숫자가 아니라 링크인가

3단계에서 만든 `RESEND_API_KEY`는 **Sending access** 권한이라 메일 발송만 할 수 있습니다.
발송량 조회는 발송 목록을 읽는 동작이라 Resend가 `401 restricted_api_key`로 거부합니다.
이걸 뚫으려면 키를 **Full access**로 바꿔야 하는데, 그러면 도메인과 API 키까지 만들고
지울 수 있는 키가 Worker에 놓입니다. 숫자 한 줄을 앱에서 보려고 감수할 거래가 아니라서
앱은 대시보드 링크만 띄웁니다.

### Cloudflare 항목 설정

1. 계정 ID 확인 — `npx wrangler whoami` (PowerShell에서는 `npx.cmd wrangler whoami`)
2. API 토큰 생성 — Cloudflare 대시보드 → 프로필 → **API Tokens** → **Create Token**
   → **Create Custom Token** → Permissions: `Account` · `Account Analytics` · **Read**,
   Account Resources: `Include` · 본인 계정
3. 시크릿 등록

```bash
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
```

시크릿은 재배포 없이 바로 반영됩니다. 읽기 전용 권한이라 토큰이 새어도 설정을 바꾸지는
못합니다.

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
MAIL_TO=me@example.com
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
curl -H "Authorization: Bearer 로컬_테스트용_임의_문자열" \
  "http://localhost:8787/__cron?test=1"
```

### 화면만 빠르게 확인하기

다음 명령은 `public` 폴더의 HTML, CSS, JavaScript만 단순 웹 서버로 보여 줍니다.

```bash
python -m http.server 8000 --directory public
```

브라우저에서 `http://localhost:8000`을 엽니다. 이 방식은 화면 확인용이므로
`worker/index.js`, 예약 실행, `/__cron` 메일 발송 기능은 실행되지 않습니다.

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
- `public/_headers`의 CSP가 외부 스크립트 실행과 깃허브 API 외의 외부 통신을 막습니다.
- 남이 준 `data.json`을 **불러오기**로 받을 때는 그 안의 링크도 위 규칙으로 걸러집니다.

## 코드를 바꿨다면 다시 배포하세요

이 저장소를 Fork해서 쓰고 있다면 꼭 기억해 주세요. **`public/`이나 `worker/`의 코드를
고치거나, 원본 저장소의 변경 사항을 받아 왔다면 그때마다 다시 배포해야 실제 사이트에
반영됩니다.** Cloudflare는 배포된 시점의 파일을 서빙하므로, Git에 커밋·푸시하는 것만으로는
사이트가 바뀌지 않습니다.

```bash
git pull                 # 원본 변경 사항을 받아 왔다면
npx wrangler deploy
```

- 브라우저 앱(`public/`)과 Worker(`worker/`)는 한 번의 `wrangler deploy`로 함께 올라갑니다.
- `wrangler.jsonc`의 `vars`를 고친 경우에도 재배포해야 적용됩니다.
- 시크릿(`npx wrangler secret put ...`)은 재배포 없이 바로 반영됩니다.
- 배포한 뒤에도 화면이 그대로면 브라우저 강력 새로고침(Ctrl/Cmd + Shift + R)을 해 보세요.
- 설정창의 **사용량**에서 `/__usage 를 찾을 수 없습니다 (404)`가 뜨면 재배포가 안 된 상태입니다.

## 주요 기능

- 문제 번호·제목·사이트·난이도·결과 기록
- 실패 문제 3일·7일·21일 복습 일정
- 월별 문제/복습 잔디
- C++·Java·Python별 Markdown 개념 노트와 이미지
- 주간 일정표
- 여러 기기 간 GitHub 동기화와 충돌 처리
- JSON 내보내기/불러오기
- Resend를 이용한 자동 복습 메일
- 깃허브·Resend·Cloudflare 사용량 확인
