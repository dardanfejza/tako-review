/**
 * Catalog of deliberately-flawed snippets for the Sample Code button (spec §5.2).
 * Each entry is short (8-15 lines) and hides 1-3 review-worthy bugs so the model
 * always has something concrete to flag. Entry 0 is the original Python sample —
 * `SAMPLE_CODE` (ReviewWorkspace's onTrySample) re-exports its code.
 */
export interface SampleSnippet {
  /** Display/dedup key — one entry per language. */
  language: string;
  code: string;
}

export const SAMPLE_CATALOG: SampleSnippet[] = [
  {
    language: 'python',
    code: `def average(nums):
    total = 0
    for n in nums:
        total += n
    return total / len(nums)  # ZeroDivisionError when nums is empty

def get_user(db, user_id):
    # SQL injection: user_id is interpolated directly into the query
    return db.execute("SELECT * FROM users WHERE id = " + user_id)
`,
  },
  {
    language: 'javascript',
    code: `function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn(args), delay); // passes the array, not ...args; loses \`this\`
  };
}

const ids = ['10', '9', '8'];
ids.sort(); // lexicographic sort: '10' < '8' — numeric compare is missing
console.log(ids.map((id) => parseInt(id))); // parseInt without an explicit radix
`,
  },
  {
    language: 'typescript',
    code: `interface User {
  id: number;
  name?: string;
}

async function fetchUsers(api: string): Promise<User[]> {
  const res = await fetch(api);
  return res.json(); // no res.ok check; json() is \`any\` — silently trusted as User[]
}

export function shortNames(users: User[]): string[] {
  return users.map((u) => u.name!.slice(0, 8)); // non-null assertion on an optional field
}
`,
  },
  {
    language: 'go',
    code: `func process(items []string) []*string {
	out := make([]*string, 0, len(items))
	for _, item := range items {
		out = append(out, &item) // pre-Go 1.22: every pointer aliases the same loop variable
	}
	return out
}

func readConfig(path string) string {
	data, _ := os.ReadFile(path) // error silently discarded
	return string(data)
}
`,
  },
  {
    language: 'rust',
    code: `fn parse_port(input: &str) -> u16 {
    input.trim().parse().unwrap() // panics on any non-numeric input
}

fn average(values: &[i32]) -> i32 {
    let sum: i32 = values.iter().sum(); // can overflow on large inputs
    sum / values.len() as i32 // divide-by-zero panic on an empty slice
}
`,
  },
  {
    language: 'java',
    code: `public class SessionStore {
    private static Map<String, String> cache = new HashMap<>(); // shared, not thread-safe

    public boolean isAdmin(String role) {
        return role == "admin"; // reference equality instead of .equals()
    }

    public String firstToken(String header) {
        return header.split(",")[0].trim(); // NullPointerException when header is null
    }
}
`,
  },
  {
    language: 'c',
    code: `char *join_path(const char *dir, const char *file) {
    char buf[64];
    strcpy(buf, dir); /* no bounds check: overflow for long dir */
    strcat(buf, "/");
    strcat(buf, file);
    return buf; /* returns a pointer to stack memory */
}

int read_age(void) {
    int age;
    scanf("%d", &age); /* return value unchecked: age may stay uninitialized */
    return age;
}
`,
  },
  {
    language: 'ruby',
    code: `def find_user(id)
  user = User.where("id = #{id}").first # SQL injection via string interpolation
  user.name # NoMethodError when no row matched (user is nil)
end

def dedupe(items = [])
  items.uniq! # uniq! returns nil when nothing was removed — callers get nil, not the array
end
`,
  },
  {
    language: 'sql',
    code: `-- Refund orders for customers who cancelled this month
UPDATE orders
SET status = 'refunded';
-- missing WHERE clause: refunds every order in the table

SELECT c.name, COUNT(*) AS order_count
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'active' -- filtering the right table turns the LEFT JOIN into an INNER JOIN
GROUP BY c.name; -- names are not unique: distinct customers get merged
`,
  },
  {
    language: 'shell',
    code: `#!/bin/bash
backup_dir=$1
rm -rf $backup_dir/old # unquoted: empty $1 makes this "rm -rf /old"; spaces split the path
for f in $(ls *.log); do # parsing ls output word-splits filenames containing spaces
  cp $f "$backup_dir"
done
cd /var/data
tar czf backup.tar.gz . # cd is unchecked: on failure tar archives the wrong directory
`,
  },
];

/**
 * Pick a catalog index from `random()` ([0,1)), never repeating `lastIndex`:
 * on a collision the roll is offset by one (wrapping), so consecutive picks
 * always differ while staying uniform enough for a demo button.
 */
export function pickSampleIndex(
  lastIndex: number | null,
  random: () => number = Math.random,
): number {
  const n = SAMPLE_CATALOG.length;
  const roll = Math.floor(random() * n);
  return roll === lastIndex ? (roll + 1) % n : roll;
}
