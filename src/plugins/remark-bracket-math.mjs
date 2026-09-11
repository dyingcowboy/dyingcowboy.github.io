export default function remarkBracketMath() {
  return (tree) => {
    const walk = (node) => {
      if (!Array.isArray(node.children)) return;

      node.children = node.children.map((child) => {
        if (
          child.type === 'paragraph' &&
          child.children?.length === 1 &&
          child.children[0].type === 'text'
        ) {
          // Markdown consumes the escaping backslashes in \[ ... \], so at
          // this stage the paragraph is represented as "[\n...\n]".
          const value = child.children[0].value;
          const match = value.match(/^\[\n([\s\S]+)\n\]$/);

          if (match) {
            return {
              type: 'paragraph',
              data: {
                hName: 'div',
                hProperties: {
                  className: ['math', 'math-display'],
                },
              },
              children: [
                {
                  type: 'text',
                  value: match[1].trim(),
                },
              ],
            };
          }
        }

        walk(child);
        return child;
      });
    };

    walk(tree);
  };
}
