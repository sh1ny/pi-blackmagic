import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { combinedPackages, packageIdentity } from "../src/native-resources.ts";

const bases = {
  user: resolve("synthetic-agent"),
  project: resolve("synthetic-project/.pi"),
};

test("package identities reconcile npm versions and SSH/HTTPS/git repository refs", () => {
  expect(packageIdentity("npm:@synthetic/pkg@1.0.0", bases.user)).toBe(
    "npm:@synthetic/pkg",
  );
  expect(packageIdentity("npm:@synthetic/pkg@next", bases.project)).toBe(
    "npm:@synthetic/pkg",
  );
  for (const source of [
    "git:github.com/synthetic/repo@v1",
    "git:git@github.com:synthetic/repo.git@v2",
    "https://github.com/synthetic/repo.git",
    "ssh://git@github.com/synthetic/repo.git@v3",
    "git:github:synthetic/repo",
  ])
    expect(packageIdentity(source, bases.user)).toBe(
      "git:github.com/synthetic/repo",
    );
  expect(packageIdentity("./local", bases.user)).toBe(
    `local:${join(bases.user, "local")}`,
  );
  expect(packageIdentity("./local", bases.project)).not.toBe(
    packageIdentity("./local", bases.user),
  );
});

test("project packages replace user identity, while autoload-disabled entries retain user base", () => {
  const user = [
    "npm:synthetic@1",
    { source: "npm:delta@1", skills: ["!excluded/**"] },
    "./local",
  ];
  const project = [
    "npm:synthetic@2",
    { source: "npm:delta@2", autoload: false, skills: ["+entry.md"] },
    "./local",
  ];
  expect(combinedPackages(user, project, bases)).toEqual([
    ...project,
    { source: "npm:delta@1", skills: ["!excluded/**"] },
    "./local",
  ]);
});

test("same absolute local package deduplicates with project precedence without filesystem inspection", () => {
  const source = resolve("does-not-exist-synthetic-package");
  expect(
    combinedPackages(
      [source],
      [{ source, extensions: ["-excluded.ts"] }],
      bases,
    ),
  ).toEqual([{ source, extensions: ["-excluded.ts"] }]);
  expect(
    combinedPackages(
      ["git:git@selfhost.invalid:group/repo.git@v1"],
      ["https://selfhost.invalid/group/repo.git@v2"],
      bases,
    ),
  ).toEqual(["https://selfhost.invalid/group/repo.git@v2"]);
});
