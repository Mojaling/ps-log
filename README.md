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
| `CRON_KEY` | 수동 메일 발송 URL을 보호하는 비밀키 | 임의의 64자리 문자열 |
| `MAIL_FROM` | 발신 주소. 개인 도메인을 쓸 때만 설정 | `PS Log <review@example.com>` |

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

배포할 때 출력된 실제 Worker URL과 본인의 `CRON_KEY`를 사용합니다.

```text
https://ps-log.<내-workers.dev-서브도메인>.workers.dev/__cron?key=<CRON_KEY>&test=1
```

예를 들어 Worker URL이 `https://ps-log.example.workers.dev`이고 `CRON_KEY`가
`abc123`이라면 다음과 같습니다. `abc123`은 설명용이므로 실제로 사용하면 안 됩니다.

```text
https://ps-log.example.workers.dev/__cron?key=abc123&test=1
```

브라우저에서 위 주소를 열거나 터미널에서 `curl`로 호출할 수 있습니다. `&test=1`을
붙이면 메일 제목에 `[테스트]`가 표시됩니다. URL에 실제 `CRON_KEY`가 포함되므로 다른
사람에게 공유하거나 README에 올리지 마세요.

- `테스트 메일을 발송했습니다.`: 정상
- `Forbidden`: `CRON_KEY` 확인
- `GitHub 404`: 저장소·브랜치·토큰 접근 범위 확인
- `Resend 403`: 무료 계정의 수신 주소 제한 확인

cron은 기본적으로 매일 UTC 23:00, 한국 시각 오전 8시에 실행됩니다.

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
```

그다음 실행합니다.

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:8787`을 엽니다. 이 방식은 정적 화면뿐 아니라
`worker/index.js`, `/__cron`, 메일 발송 같은 Worker 기능도 로컬에서 실행합니다.

로컬 테스트 메일 호출 예시:

```text
http://localhost:8787/__cron?key=로컬_테스트용_임의_문자열&test=1
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

## 주요 기능

- 문제 번호·제목·사이트·난이도·결과 기록
- 실패 문제 3일·7일·21일 복습 일정
- 월별 문제/복습 잔디
- C++·Java·Python별 Markdown 개념 노트와 이미지
- 주간 일정표
- 여러 기기 간 GitHub 동기화와 충돌 처리
- JSON 내보내기/불러오기
- Resend를 이용한 자동 복습 메일
