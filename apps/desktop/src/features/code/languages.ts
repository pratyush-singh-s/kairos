import type { Extension } from "@codemirror/state";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";

export interface Language {
  name: string;
  /** Short tag shown in the file tree, like a Nerd Font icon would be. */
  tag: string;
  ext: string[];
  support: () => Extension;
  /** What a new file starts with. */
  starter: (stem: string) => string;
}

export const LANGUAGES: Language[] = [
  {
    name: "Python",
    tag: "py",
    ext: ["py"],
    support: python,
    starter: () => 'name = input("What is your name? ")\nprint(f"Hello, {name}!")\n',
  },
  {
    name: "C",
    tag: "c",
    ext: ["c", "h"],
    support: cpp,
    starter: () =>
      '#include <stdio.h>\n\nint main(void) {\n    char name[64];\n    printf("What is your name? ");\n    if (scanf("%63s", name) == 1) {\n        printf("Hello, %s!\\n", name);\n    }\n    return 0;\n}\n',
  },
  {
    name: "C++",
    tag: "c++",
    ext: ["cpp", "cc", "hpp"],
    support: cpp,
    starter: () =>
      '#include <iostream>\n#include <string>\n\nint main() {\n    std::string name;\n    std::cout << "What is your name? ";\n    std::cin >> name;\n    std::cout << "Hello, " << name << "!\\n";\n    return 0;\n}\n',
  },
  {
    name: "Java",
    tag: "jv",
    ext: ["java"],
    support: java,
    starter: (stem) =>
      `import java.util.Scanner;\n\npublic class ${stem.replace(/[^A-Za-z0-9_]/g, "_") || "Main"} {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        System.out.print("What is your name? ");\n        String name = in.next();\n        System.out.println("Hello, " + name + "!");\n    }\n}\n`,
  },
  {
    name: "JavaScript",
    tag: "js",
    ext: ["js"],
    support: javascript,
    starter: () => 'console.log("Hello from Node!");\n',
  },
  {
    name: "Rust",
    tag: "rs",
    ext: ["rs"],
    support: rust,
    starter: () => 'fn main() {\n    println!("Hello from Rust!");\n}\n',
  },
  {
    name: "Go",
    tag: "go",
    ext: ["go"],
    support: go,
    starter: () => 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello from Go!")\n}\n',
  },
];

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function languageOf(name: string): Language | undefined {
  const ext = extOf(name);
  return LANGUAGES.find((l) => l.ext.includes(ext));
}

/** Header files and notes can be edited but not run. */
export function canRun(name: string): boolean {
  return ["py", "c", "cpp", "cc", "java", "js", "rs", "go"].includes(extOf(name));
}

export const ALLOWED = ["py", "c", "cpp", "cc", "h", "hpp", "java", "js", "rs", "go", "txt"];
